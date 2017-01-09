/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2017, Joyent, Inc.
 */

/*
 * Some relevant info regarding image handling in sdc-docker that should help
 * maintenance of this file.
 *
 * - Remote API endpoints are defined in lib/endpoints/images.js". They
 *   typically call methods in this file to do their work.
 * - Related models (persistent data stored in Moray):
 *      ImageTag            An account's tagged images. Given an image name,
 *                          e.g. 'bob/ubuntu:latest', a lookup in this Moray
 *                          bucket will tell if the account has that image
 *                          pulled and tagged.
 *      Image               All pulled images for each account (not just
 *                          tagged ones). This table holds Docker image
 *                          metadata for each pulled image.
 *
 * Common naming:
 *
 *      imgId               A Docker image ID, the full 64-char string.
 *                          Also sometimes called `docker_id`.
 *      imgTag              An ImageTag instance
 *      img                 An Image model instance
 *      imageUuid, uuid, image_uuid
 *                          "uuid" always refers to the SDC IMGAPI UUID for
 *                          this Docker image.
 *      imgapiImg           Naming for an IMGAPI image (i.e. the manifest obj)
 *      imageJson           JSON layer, see the docker image specification v1.0
 */

var assert = require('assert-plus');
var crypto = require('crypto');
var format = require('util').format;
var fs = require('fs');
var imgmanifest = require('imgmanifest');
var drc = require('docker-registry-client');
var path = require('path');
var sdcClients = require('sdc-clients');
var IMGAPI = sdcClients.IMGAPI;
var VMAPI = sdcClients.VMAPI;
var vasync = require('vasync');

var common = require('../../common');
var Image = require('../../models/image');
var ImageTag = require('../../models/image-tag');
var ImageV2 = require('../../models/image-v2');
var ImageTagV2 = require('../../models/image-tag-v2');
var errors = require('../../../lib/errors');
var utils = require('./utils');



//---- globals

var _vmapiClientCache; // set in `getVmapiClient`
var gScratchImage = null; // set by getScratchImage

//---- internal support routines

function getVmapiClient(config) {
    if (!_vmapiClientCache) {
        // intentionally global
        _vmapiClientCache = new VMAPI(config);
    }
    return _vmapiClientCache;
}


/**
 * Return the array of image tags for the given image.
 */
function tagsForImage(img, opts, callback) {
    assert.object(img, 'img');
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.index_name, 'opts.index_name');
    assert.func(callback, 'callback');

    var filter;

    if (isV1Image(img)) {
        filter = [
            {owner_uuid: opts.account.uuid, docker_id: img.docker_id}
        ];
        if (opts.index_name) {
            filter[0].index_name = opts.index_name;
        }
        ImageTag.list(opts.app, opts.log, filter, callback);
        return;
    }

    filter = [
        {owner_uuid: opts.account.uuid, digest: img.digest}
    ];
    ImageTagV2.list(opts.app, opts.log, filter, callback);
}


/**
 * Convert a docker image json layer (as given from docker hub) into a
 * sdc-docker Image model structure.
 *
 * @param imageJson {Object} Contains the docker image info.
 * @param opts {Object} Sdc-docker specific settings for image.
 * @returns {Object} Image model object.
 */
function dockerImageJsonToModel(imageJson, opts) {
    assert.object(imageJson, 'imageJson');
    assert.object(opts, 'opts');
    assert.string(opts.digest, 'opts.digest');
    assert.optionalBool(opts.head, 'opts.head');
    assert.string(opts.image_uuid, 'opts.image_uuid');
    assert.string(opts.manifest_str, 'opts.manifest_str');
    assert.string(opts.manifest_digest, 'opts.manifest_digest');
    assert.optionalString(opts.owner_uuid, 'opts.owner_uuid');
    assert.number(opts.size, 'opts.size');

    var modelObj = {
        digest: opts.digest,
        head: (opts.head || false),
        image: imageJson,
        image_uuid: opts.image_uuid,
        manifest_digest: opts.manifest_digest,
        manifest_str: opts.manifest_str,
        owner_uuid: opts.owner_uuid,
        size: (opts.size || 0)
    };

    return modelObj;
}


/**
 * Get all the images available to the given account.
 *
 * @param {Object} opts
 * @param {String} opts.account The account to which to limit access.
 * @param {Object} opts.all Include intermediate docker layer images.
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param {UUID} opts.req_id
 * @param callback {Function} `function (err, images)`
 */
function listImages(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');
    assert.optionalBool(opts.all, 'opts.all');
    assert.number(opts.clientApiVersion, 'opts.clientApiVersion');
    assert.optionalString(opts.filters, 'opts.filters');
    assert.optionalBool(opts.skip_v1_images, 'opts.skip_v1_images');
    assert.optionalBool(opts.skip_smartos, 'opts.skip_smartos');
    assert.string(opts.req_id, 'opts.req_id');

    var app = opts.app;
    var log = opts.log;
    var dockerImages = [];
    var imageFilters = JSON.parse(opts.filters || '{}');
    imageFilters = utils.getNormalizedFilters(imageFilters);
    if (imageFilters instanceof Error) {
        callback(new errors.DockerError('invalid filters: ' + imageFilters));
        return;
    }

    var funcs = [];
    if (!opts.skip_smartos) {
        funcs.push(listSmartOSImages);
    }
    funcs.push(listDockerImagesV2);
    if (!opts.skip_v1_images) {
        funcs.push(listDockerImagesV1);
    }

    vasync.parallel({funcs: funcs}, function (err) {
        if (err) {
            callback(err);
            return;
        }

        // Images are sorted newest (0) to oldest (n).
        dockerImages.sort(function (entry1, entry2) {
            return entry2.Created - entry1.Created;
        });

        callback(null, dockerImages);
    });

    function listSmartOSImages(next) {
        var filters = {
            type: 'zone-dataset',
            account: opts.account.uuid,
            state: 'active'
        };

        app.imgapi.listImages(filters, {
            headers: {'x-request-id': opts.req_id}
        }, function (err, images) {
            var results = [];

            if (err) {
                next(err);
                return;
            }

            images.forEach(function (img) {
                var dockerImage = {};
                var origin = img.origin || '';

                dockerImage.RepoTags = [img.uuid];
                dockerImage.Id = (img.uuid + img.uuid).replace(/-/g, '');
                dockerImage.ParentId = (origin + origin).replace(/-/g, '');
                dockerImage.Created = Math.floor((new Date(img.published_at))
                    .getTime() / 1000);
                // Note: Slightly different semantics. This is showing the
                // (possibly compressed) image file size. Good enough.
                dockerImage.Size = img.files[0].size;
                // Note: this doesn't handle ancestry size.
                dockerImage.VirtualSize = img.files[0].size;

                results.push(dockerImage);
            });

            log.trace({imgs: results}, 'listImages: listSmartOSImages');
            dockerImages = dockerImages.concat(results);
            next();
        });
    }

    function imageFilter(img) {
        var isMatch = true;

        Object.keys(imageFilters).forEach(function (field) {
            var val = imageFilters[field];
            log.debug('filtering image on field ' + field + ', value ' + val);
            if (field === 'dangling') {
                // Note: We currently don't have any dangling (untagged) images.
                // val is an *array* of *strings* in form 'true', 'false', so
                // just take the last value in the array.
                if (common.boolFromQueryParam(val[val.length - 1])) {
                    isMatch = false;
                }
            } else if (field === 'label') {
                // val is an *array* of acceptable image labels's *strings*, so
                // check if image matches *all* of the requested values.
                var imgLabelsObj = img.config.Labels || {};
                var imgLabelNames = Object.keys(imgLabelsObj);
                if (!val.every(function (wantedLabelData) {
                    // wantedLabelData is in format 'key=value'
                    var split = wantedLabelData.split('=', 2);
                    var wantedLabel = split[0];
                    var wantedValue = split[1];
                    return imgLabelNames.some(function (imgLabelName) {
                        return imgLabelName === wantedLabel
                                && imgLabelsObj[imgLabelName] === wantedValue;
                    });
                })) {
                    isMatch = false;
                }
            } else {
                log.warn('Unhandled image filter name:', field);
                throw new errors.DockerError(format(
                            'Invalid filter \'%s\'', field));
            }
        });

        return isMatch;
    }

    function listDockerImagesV2(next) {
        var params = { owner_uuid: opts.account.uuid };
        var results = [];

        if (!opts.all) {
            params.head = true;
        }

        ImageV2.list(app, log, params, function (err, imgs) {
            log.debug('listDockerImagesV2:: found %d imgs', imgs.length);
            if (err) {
                next(err);
                return;
            }

            // Filter images when requested by the client.
            if (!common.objEmpty(imageFilters)) {
                log.debug({ 'imageFilters': imageFilters}, 'filtering images');
                try {
                    imgs = imgs.filter(imageFilter);
                } catch (e) {
                    next(e);
                    return;
                }
            }

            vasync.forEachParallel({
                func: getTagsV2,
                inputs: imgs
            }, function (getErr) {
                if (getErr) {
                    next(getErr);
                    return;
                }

                log.trace({imgs: results}, 'listImages: listDockerImagesV2');
                dockerImages = dockerImages.concat(results);
                next();
            });
        });

        function _addImageV2(img, repoTags, repoDigests) {
            assert.optionalArrayOfString(repoTags, 'repoTags');

            if (!repoTags || repoTags.length === 0) {
                repoTags = ['<none>:<none>'];
            }
            if (!repoDigests || repoDigests.length === 0) {
                repoDigests = ['<none>@<none>'];
            }
            var imgConfig = img.config || {};
            var dockerImage = {
                Created: img.created,
                Id: img.digest,
                Labels: img.config.Labels || null,
                ParentId: img.parent || '',
                RepoTags: repoTags,
                RepoDigests: repoDigests,
                Size: img.size,
                VirtualSize: img.size
            };

            results.push(dockerImage);
        }

        function getTagsV2(img, cb) {
            // Intermediate layers don't have tags.
            if (!img.head) {
                _addImageV2(img);
                cb();
                return;
            }

            tagsForImage(img, {app: app, log: log, account: opts.account},
                    function (err, imgTags) {
                if (err) {
                    cb(err);
                    return;
                }
                if (imgTags && imgTags.length > 0) {
                    var repoTags = imgTags.map(function (it) {
                        return it.repo + ':' + it.tag;
                    });
                    var repoDigests = imgTags.map(function (it) {
                        return it.repo + '@' + it.digest;
                    });
                    _addImageV2(img, repoTags, repoDigests);
                } else {
                    _addImageV2(img);
                }
                cb();
            });
        }
    }

    function listDockerImagesV1(next) {
        var params = { owner_uuid: opts.account.uuid };
        var results = [];

        if (!opts.all) {
            params.head = true;
        }

        Image.list(app, log, params, function (err, imgs) {
            if (err) {
                next(err);
                return;
            }

            // Filter images when requested by the client.
            if (!common.objEmpty(imageFilters)) {
                log.debug({ 'imageFilters': imageFilters}, 'filtering images');
                try {
                    imgs = imgs.filter(imageFilter);
                } catch (e) {
                    next(e);
                    return;
                }
            }

            vasync.forEachParallel({
                func: getTags,
                inputs: imgs
            }, function (getErr) {
                if (getErr) {
                    next(getErr);
                    return;
                }

                log.trace({imgs: results}, 'listImages: listDockerImagesV1');
                dockerImages = dockerImages.concat(results);
                next();
            });
        });


        function pushImage(img, repoTags) {
            assert.optionalArrayOfString(repoTags, 'repoTags');

            // reminder: img.config is the image config, img.container_config
            // is the config for the container that created the image.
            var imgConfig = img.config || {};
            var dockerImage = {
                RepoTags: (repoTags && repoTags.length
                    ? repoTags : ['<none>:<none>']),
                Id: img.docker_id,
                Created: Math.floor((new Date(img.created))
                            .getTime() / 1000),
                Cmd: imgConfig.Cmd,
                Env: imgConfig.Env,
                Entrypoint: imgConfig.Entrypoint,
                ParentId: img.parent || '',
                Size: img.size,
                Tty: imgConfig.Tty,
                User: imgConfig.User,
                VirtualSize: img.virtual_size,
                Volumes: imgConfig.Volumes,
                WorkingDir: imgConfig.WorkingDir
            };

            results.push(dockerImage);
        }

        function getTags(img, cb) {
            // Intermediate layers don't have tags.
            var serialized = img.serialize();
            if (!serialized.head) {
                pushImage(serialized);
                cb();
                return;
            }

            tagsForImage(img, {app: app, log: log, account: opts.account},
                    function (err, imgTags) {
                if (err) {
                    cb(err);
                    return;
                }
                if (imgTags) {
                    var repoTags = imgTags.map(function (it) {
                        return it.repo + ':' + it.tag;
                    });
                    pushImage(serialized, repoTags);
                } else {
                    pushImage(serialized);
                }
                cb();
            });
        }
    }
}


/**
 * Gets an image -- an Image model object -- from (account, indexName, imgId).
 *
 * @param {Object} opts
 * @param {Object} opts.account
 * @param {Object} opts.indexName
 * @param {Object} opts.imgId
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, img)`
 */
function imgFromImgInfoV1(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.indexName, 'opts.indexName');
    assert.string(opts.imgId, 'opts.imgId');

    var filter = {
        owner_uuid: opts.account.uuid,
        index_name: opts.indexName,
        docker_id: opts.imgId
    };
    Image.list(opts.app, opts.log, filter, function (err, imgs) {
        if (err) {
            callback(err);
            return;
        } else if (!imgs.length) {
            callback(new errors.ResourceNotFoundError(format(
                'No such image id (from registry %s): %s', opts.indexName,
                opts.imgId)));
            return;
        }
        assert.equal(imgs.length, 1);
        callback(null, imgs[0]);
    });
}


/**
 * Gets an image -- an ImageV2 model object -- from (account, digest).
 *
 * @param {Object} opts
 * @param {Object} opts.account
 * @param {Object} opts.digest
 * @param {Object} opts.log Bunyan log instance
 * @param {Object} opts.app App instance
 * @param callback {Function} `function (err, img)`
 */
function imgFromImgInfoV2(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.digest, 'opts.digest');

    var filter = {
        owner_uuid: opts.account.uuid,
        digest: opts.digest
    };
    ImageV2.list(opts.app, opts.log, filter, function (err, imgs) {
        if (err) {
            callback(err);
            return;
        } else if (!imgs.length) {
            callback(new errors.ResourceNotFoundError(format(
                'No such image: %s', opts.digest)));
            return;
        }
        assert.equal(imgs.length, 1);
        callback(null, imgs[0]);
    });
}


function _imgFromNameV2(opts, callback) {
    var imgTag;
    var img;
    var imgIsGone = false;
    var log = opts.log;
    var name = opts.rat.localName;
    var tag = opts.rat.tag;

    log.debug({name: name, tag: tag}, '_imgFromNameV2');

    var imgapiOpts = common.objCopy(opts.app.config.imgapi);
    imgapiOpts.headers = { 'x-request-id': log.fields.req_id };
    var imgapi = new IMGAPI(imgapiOpts);

    vasync.pipeline({funcs: [
        function findByName(_, next) {
            var filter = [
                {repo: name, owner_uuid: opts.account.uuid, tag: tag}
            ];
            ImageTagV2.list(opts.app, log, filter, function (err, imgTags) {
                if (err) {
                    next(err);
                } else if (imgTags.length === 0) {
                    next();
                } else {
                    imgTag = imgTags[0];
                    log.debug({imgTag: imgTag},
                        '_imgFromNameV2: found matching imgTag');
                    next();
                }
            });
        },

        function findImage(_, next) {
            var filter = [];
            if (imgTag) {
                // We've found an imgTag, get the `ImageV2` for it.
                filter.push({
                    digest: imgTag.digest,
                    owner_uuid: opts.account.uuid
                });
            } else if (/^sha256:[0-9a-f]+$/.test(name)) {
                // Else, could possibly be a digest, search for that.
                filter.push({
                    digest: name + '*',
                    owner_uuid: opts.account.uuid
                });
            } else if (/^[0-9a-f]+$/.test(name)) {
                // Else, could possibly be a docker Id, search for that.
                filter.push({
                    digest: 'sha256:' + name + '*',
                    owner_uuid: opts.account.uuid
                });
            } else {
                next();
                return;
            }

            ImageV2.list(opts.app, log, filter, function (err, imgs) {
                if (err || imgs.length === 0) {
                    /*jsl:pass*/
                } else if (imgs.length === 1) {
                    img = imgs[0];
                    log.debug({imgName: name, img: img},
                        '_imgFromNameV2: findImage');
                } else {
                    // Docker gives a 404 if multiple images are matched.
                    next(true);  /* early abort */
                    return;
                }
                next(err);
            });
        },

        function isImageInImgapi(_, next) {
            if (!img) {
                return next(true); // early abort
            }

            imgapi.getImage(img.image_uuid, function (err, imgapiImg) {
                if (err) {
                    if (err.statusCode === 404) {
                        imgIsGone = true;
                        next();
                    } else {
                        next(err);
                    }
                } else {
                    next(true); // early abort
                }
            });
        },

        /*
         * If we get here then we found an `img`, but it isn't in IMGAPI
         * (`imgIsGone`). We need to clear these refs from the sdc-docker DB.
         */
        function delImgRef(_, next) {
            assert.ok(img);
            assert.ok(imgIsGone);

            log.debug({imgIsGone: imgIsGone, img: img},
                'imgFromName: delImgRef');
            ImageV2.del(opts.app, log, img, next);
        },

        function delImgTagRef(_, next) {
            assert.ok(imgIsGone);
            if (!imgTag) {
                return next();
            }

            log.debug({imgIsGone: imgIsGone, imgTag: imgTag},
                'imgFromName: delImgTagRef');
            ImageTagV2.del(opts.app, log, imgTag, next);
        }

    ]}, function (err) {
        if (err === true) { /* the signal for an early abort */
            err = null;
        }
        if (err) {
            callback(err);
        } else if (imgIsGone) {
            callback(null);
        } else {
            callback(null, img, imgTag);
        }
    });
}

/**
 * Ambiguity notes (**only applies to v1 images**):
 *
 * 1. One form of ambiguity is if an imgId prefix matches more than one imgId.
 *    For this case, this function returns no imgTag.
 * 2. There is another form. Because SDC's design of keeping Docker images from
 *    different registry hosts separate, even if they have the same imgId, we
 *    have a potential confusion for users and an *inherent ambiguity in
 *    referring to images by imgId*. E.g., the same busybox image pulled from
 *    docker.io and from quay.io will have the same imgId, but different
 *    imgUuid in SDC. For now, if such an ambiguity comes up we'll return
 *    an error here: `AmbiguousDockerImageIdError`.
 */
function _imgFromNameV1(opts, callback) {
    var imgTag;
    var img;
    var imgIsGone = false;
    var log = opts.log;
    var name = opts.rat.localName;
    var tag = opts.rat.tag;

    var imgapiOpts = common.objCopy(opts.app.config.imgapi);
    imgapiOpts.headers = { 'x-request-id': log.fields.req_id };
    var imgapi = new IMGAPI(imgapiOpts);

    vasync.pipeline({funcs: [
        function findByName(_, next) {
            var filter = [
                {repo: name, owner_uuid: opts.account.uuid, tag: tag}
            ];
            if (opts.index_name) {
                filter[0].index_name = opts.index_name;
            }
            ImageTag.list(opts.app, log, filter, function (err, imgTags) {
                if (err) {
                    next(err);
                } else if (imgTags.length === 0) {
                    next();
                } else {
                    imgTag = imgTags[0];
                    log.debug({imgName: name, imgTag: imgTag},
                        '_imgFromNameV1: findByName');
                    next();
                }
            });
        },

        function findImage(_, next) {
            var filter = [];
            if (imgTag) {
                // We've found an imgTag, get the `Image` for it.
                filter.push({docker_id: imgTag.docker_id,
                    owner_uuid: opts.account.uuid});
            } else if (/^[0-9a-f]+$/.test(name) && name.length <= 64) {
                // Else, could possibly be an imgId, search for that.
                if (name.length === 64) {
                    filter.push(
                        {docker_id: name, owner_uuid: opts.account.uuid});
                } else {
                    filter.push(
                        {docker_id: name + '*', owner_uuid: opts.account.uuid});
                }
            } else {
                next();
                return;
            }
            if (opts.index_name) {
                filter[0].index_name = opts.index_name;
            }

            Image.list(opts.app, log, filter, function (err, imgs) {
                if (err || imgs.length === 0) {
                    /*jsl:pass*/
                } else if (imgs.length === 1) {
                    img = imgs[0];
                    log.debug({imgName: name, img: img},
                        '_imgFromNameV1: findImage');
                } else {
                    var imgIds = {};
                    var indexNames = [];
                    for (var i = 0; i < imgs.length; i++) {
                        var ix = imgs[i];
                        imgIds[ix.docker_id] = true;
                        indexNames.push(ix.index_name);
                    }
                    if (Object.keys(imgIds).length === 1) {
                        assert.ok(indexNames.length > 1);
                        /*
                         * We have multiple hits for a single imgId, this is
                         * ambiguity case #2 described above.
                         */
                        err = new errors.AmbiguousDockerImageIdError(
                            name, indexNames);
                    }
                }
                next(err);
            });
        },

        function isImageInImgapi(_, next) {
            if (!img) {
                return next(true); // early abort
            }

            imgapi.getImage(img.image_uuid, function (err, imgapiImg) {
                if (err) {
                    if (err.statusCode === 404) {
                        imgIsGone = true;
                        next();
                    } else {
                        next(err);
                    }
                } else {
                    next(true); // early abort
                }
            });
        },

        /*
         * If we get here then we found an `img`, but it isn't in IMGAPI
         * (`imgIsGone`). We need to clear these refs from the sdc-docker DB.
         */
        function delImgRef(_, next) {
            assert.ok(img);
            assert.ok(imgIsGone);

            log.debug({imgIsGone: imgIsGone, img: img},
                '_imgFromNameV1: delImgRef');
            Image.del(opts.app, log, img, next);
        },
        function delImgTagRef(_, next) {
            assert.ok(imgIsGone);
            if (!imgTag) {
                return next();
            }

            log.debug({imgIsGone: imgIsGone, imgTag: imgTag},
                '_imgFromNameV1: delImgTagRef');
            ImageTag.del(opts.app, log, imgTag, next);
        }

    ]}, function (err) {
        if (err === true) { /* the signal for an early abort */
            err = null;
        }
        if (err) {
            callback(err);
        } else if (imgIsGone) {
            callback(null);
        } else {
            callback(null, img, imgTag);
        }
    });
}

/**
 * Find the img (an 'Image' or 'ImageV2' model object instance) for the named
 * Docker image (and for the given account).
 *
 * Given a name, e.g. 'cafe', that could be either a name or an id prefix,
 * Docker semantics say that *name* wins. That means we need to lookup by
 * name first, then fallback to imgId prefix.
 *
 * Theoretically, it is *sdc-docker's* data in moray that determines if a
 * particular image exists. However, the images (layers) are stored in IMGAPI
 * and can (whether by accident or not) be removed from IMGAPI without
 * sdc-docker knowing it. If the image is found in sdc-docker's database, but
 * is not in IMGAPI, then the sdc-docker DB entry will be removed to lazily
 * clean up.
 *
 * Also, optionally (if `includeSmartos=true`), if a UUID for a SmartOS image
 * in the DC's IMGAPI is given, this returns a fake 'Image' model object
 * representing that IMGAPI image.
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.name An imgId, imgId prefix or image
 *      [REGHOST]NAME[:TAG] name.
 * @param {Object} opts.account
 * @param {Boolean} opts.index_name Optional. Used to avoid duplicate images.
 * @param {Boolean} opts.includeSmartos Optional. Default false. Set to true
 *      to include (faux) results
 * @param callback {Function} `function (err, img, imgTag)`
 *      `img` is an `Image` or `ImageV2` instance or will be undefined if no
 *      matching image or no *unambiguous* match was found.
 *      `imgTag` will be the `ImageTag` instance for `name` iff it was found
 *      by name. E.g. if `name` is an imgId, then `imgTag` will be undefined.
 */
function imgFromName(opts, callback) {
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.account, 'opts.account');
    assert.optionalString(opts.index_name, 'opts.index_name');
    assert.optionalBool(opts.includeSmartos, 'opts.includeSmartos');
    var log = opts.log;

    try {
        var rat = drc.parseRepoAndTag(opts.name);
    } catch (e) {
        callback(new errors.DockerError(e, e.message));
        return;
    }

    var imgTag;
    var img;
    var name = rat.localName;

    var imgapiOpts = common.objCopy(opts.app.config.imgapi);
    imgapiOpts.headers = { 'x-request-id': log.fields.req_id };
    var imgapi = new IMGAPI(imgapiOpts);

    vasync.pipeline({funcs: [
        function findUuidInImgapi(_, next) {
            if (!opts.includeSmartos || !common.isUUID(name)) {
                next();
                return;
            }

            var acct = opts.account.uuid;
            var getOpts = {
                os: 'smartos',
                state: 'active'
            };
            imgapi.getImage(name, acct, getOpts, function (err, imgapiImg) {
                if (err) {
                    if (err.statusCode === 404) {
                        next();
                    } else {
                        next(err);
                    }
                    return;
                }
                log.debug({imgName: name, imgapiImg: imgapiImg},
                    'imgFromName: findUuidInImgapi');
                // A faux `Image` model object for this IMGAPI image.
                img = {
                    image_uuid: imgapiImg.uuid,
                    os: imgapiImg.os
                };
                next(true);  /* early abort */
            });
        },

        function findByManifestDigest(_, next) {
            // Check if this a lookup by docker manifest digest.
            if (!rat.digest) {
                next();
                return;
            }
            var dockerImageOpts = {
                account: opts.account,
                app: opts.app,
                manifestDigest: rat.digest,
                log: log
            };
            imgFromManifestDigest(dockerImageOpts,
                function _imgFromDigestCb(err, _img) {
                    if (_img && !err) {
                        img = _img;
                        next(true);  /* early abort */
                        return;
                    }
                    next(err);
                }
            );
        },

        function findByImageDigest(_, next) {
            // Check if this a lookup by docker image digest.
            if (opts.name.length !== (64 + 7)
                    || opts.name.substr(0, 7) !== 'sha256:') {
                next();
                return;
            }
            var dockerImageOpts = {
                account: opts.account,
                app: opts.app,
                digest: opts.name,
                log: log
            };
            imgFromDigest(dockerImageOpts,
                function _imgFromDigestCb(err, _img) {
                    if (_img && !err) {
                        img = _img;
                        next(true);  /* early abort */
                        return;
                    }
                    next(err);
                }
            );
        },

        function findByNameV2(_, next) {
            var v2Opts = common.objCopy(opts);
            v2Opts.rat = rat;
            v2Opts.imgapi = imgapi;
            _imgFromNameV2(v2Opts, function (err, _img, _imgTag) {
                img = _img;
                imgTag = _imgTag;
                if (img && !err) {
                    next(true);  /* early abort */
                    return;
                }
                next(err);
            });
        },

        function findByNameV1(_, next) {
            var v1Opts = common.objCopy(opts);
            v1Opts.rat = rat;
            v1Opts.imgapi = imgapi;
            _imgFromNameV1(v1Opts, function (err, _img, _imgTag) {
                img = _img;
                imgTag = _imgTag;
                next(err);
            });
        }
    ]}, function (err) {
        if (err === true) { /* the signal for an early abort */
            err = null;
        }
        if (err) {
            callback(err);
        } else {
            callback(null, img, imgTag);
        }
    });
}


/**
 * Return the docker `ImageV2` model for the given docker manifest digest.
 *
 * @param {Object} opts
 * @param {Object} opts.account User account object
 * @param {Object} opts.app App instance
 * @param {String} opts.manifestDigest The docker manifest digest.
 * @param {Object} opts.log Bunyan log instance
 *
 * @param callback {Function} `function (err, image)`
 *      On success: `err` is null, `image` is an ImageV2 model object.
 *      On error: `err` is an error object.
 */
function imgFromManifestDigest(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.manifestDigest, 'opts.manifestDigest');
    assert.object(opts.log, 'opts.log');

    var img;
    var imgapi = opts.app.imgapi;
    var log = opts.log;
    var manifestDigest = opts.manifestDigest;

    vasync.pipeline({arg: {}, funcs: [
        findImage,
        checkImageInImgapi
    ]}, function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, img);
    });

    // Find the image in the sdc-docker database.
    function findImage(_, next) {
        var filter = [
            {manifest_digest: manifestDigest, owner_uuid: opts.account.uuid}
        ];
        ImageV2.list(opts.app, log, filter, function (err, imgs) {
            if (err) {
                next(err);
                return;
            }
            if (imgs.length === 0) {
                next(new errors.ResourceNotFoundError(
                    'No image with manifest digest: ' + manifestDigest));
                return;
            }
            if (imgs.length > 1) {
                log.warn({imgs: imgs},
                    'Multiple images found with same manifestDigest');
                next(new errors.DockerError(
                    'Error - multiple images with the same manifest digest: '
                    + manifestDigest));
                return;
            }
            img = imgs[0];
            log.debug({img: img}, 'imgFromDigest: found img');
            next(null, img);
        });
    }

    // Check that the image is also in imgapi.
    function checkImageInImgapi(_, next) {
        assert.object(img, 'img');
        imgapi.getImage(img.image_uuid, function (err) {
            if (err) {
                if (err.statusCode === 404) {
                    next(new errors.ResourceNotFoundError(
                        'No imgapi image with image_uuid: ' + img.image_uuid));
                    return;
                }
                next(err);
                return;
            }
            next();
        });
    }
}


/**
 * Return the docker `ImageV2` model for the given docker image digest.
 *
 * @param {Object} opts
 * @param {Object} opts.account User account object
 * @param {Object} opts.app App instance
 * @param {String} opts.digest The docker image digest.
 * @param {Object} opts.log Bunyan log instance
 *
 * @param callback {Function} `function (err, image)`
 *      On success: `err` is null, `image` is an ImageV2 model object.
 *      On error: `err` is an error object.
 */
function imgFromDigest(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.string(opts.digest, 'opts.digest');
    assert.object(opts.log, 'opts.log');

    var digest = opts.digest;
    var img;
    var imgapi = opts.app.imgapi;
    var log = opts.log;

    vasync.pipeline({arg: {}, funcs: [
        findImage,
        checkImageInImgapi
    ]}, function (err) {
        if (err) {
            callback(err);
            return;
        }
        callback(null, img);
    });

    // Find the image in the sdc-docker database.
    function findImage(_, next) {
        var filter = [
            {digest: digest, owner_uuid: opts.account.uuid}
        ];
        ImageV2.list(opts.app, log, filter, function (err, imgs) {
            if (err) {
                next(err);
                return;
            }
            if (imgs.length === 0) {
                next(new errors.ResourceNotFoundError(
                    'No image with digest: ' + digest));
                return;
            }
            if (imgs.length > 1) {
                log.warn({imgs: imgs},
                    'Multiple images found with same digest');
                next(new errors.DockerError(
                    'Error - multiple images found with the same digest: '
                    + digest));
                return;
            }
            img = imgs[0];
            log.debug({img: img}, 'imgFromDigest: found img');
            next(null, img);
        });
    }

    // Check that the image is also in imgapi.
    function checkImageInImgapi(_, next) {
        assert.object(img, 'img');
        imgapi.getImage(img.image_uuid, function (err) {
            if (err) {
                if (err.statusCode === 404) {
                    next(new errors.ResourceNotFoundError(
                        'No imgapi image with image_uuid: ' + img.image_uuid));
                    return;
                }
                next(err);
                return;
            }
            next();
        });
    }
}


/**
 * Return the ancestry of the given image. This is an ordered array of
 * `Image` model instances starting from the given image, followed by its
 * parent, and so on.
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.img The `Image` instance for which to get the history,
 *      e.g. from `imgFromName`.
 * @param {Object} opts.account
 * @param callback {Function} `function (err, ancestry, isPartialAncestry)`
 *      On success: err is null, `history` is an array of image objects.
 *      Note that it's possible that an image parent lookup may fail (we don't
 *      have that parent image) at which point the image ancestry lookup will
 *      stop and return the images is has up to that point, and
 *      isPartialAncestry will be set to true.
 */
function getImageAncestry(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.img, 'opts.img');
    assert.object(opts.account, 'opts.account');

    var ancestry = [];

    function checkAndCallback(err) {
        if (err) {
            if (err.restCode === 'ResourceNotFound' && ancestry.length >= 1) {
                // It's okay, we didn't find a parent image, but we did find
                // *some* images - that's expected in some cases.
                callback(null, ancestry, true);
                return;
            }
            callback(err);
            return;
        }
        callback(null, ancestry, false);
    }

    function addAndGetNextItem(img) {
        ancestry.push(img);

        if (!img.parent) {
            checkAndCallback(null);
            return;
        }

        if (isV1Image(img)) {
            imgFromImgInfoV1({
                app: opts.app,
                log: opts.log,
                account: opts.account,
                indexName: img.index_name,
                imgId: img.parent
            }, function (err, parentImg) {
                if (err) {
                    checkAndCallback(err);
                } else {
                    addAndGetNextItem(parentImg);
                }
            });
            return;
        }

        imgFromImgInfoV2({
            app: opts.app,
            log: opts.log,
            account: opts.account,
            digest: img.parent
        }, function (err, parentImg) {
            if (err) {
                checkAndCallback(err);
            } else {
                addAndGetNextItem(parentImg);
            }
        });

    }

    addAndGetNextItem(opts.img);
}


/**
 * Return the docker history of the given image. This is an ordered array of
 * changes made to the image, with the first change being at the end of the
 * array. Each history entry is an object containing these fields:
 *   {
 *       Id: <string>
 *       Created: <timestamp>,
 *       CreatedBy: <author string>,
 *       Size: <number>
 *   }
 *
 * @param {Object} opts
 * @param {Object} opts.app App instance
 * @param {Object} opts.log Bunyan log instance
 * @param {String} opts.img The `Image` instance for which to get the history,
 *      e.g. from `imgFromName`.
 * @param {Object} opts.account
 * @param callback {Function} `function (err, history)`
 *      On success: err is null, `history` is an array of image objects (as
 *      from `imgFromImgInfo`). On error: `err` is an error object and
 *      history is *the history determined up to the failure*.
 */
function getImageHistory(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.account, 'opts.account');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.img, 'opts.img');
    assert.object(opts.log, 'opts.log');

    var history = [];

    getImageAncestry(opts, function (err, ancestry) {
        if (err) {
            callback(err);
            return;
        }

        // Get tags for the found images.
        vasync.forEachPipeline({
            inputs: ancestry,
            func: function lookupAncestorTags(img, next) {
                var createdBy = '';
                if (img.container_config && img.container_config.Cmd) {
                    createdBy = img.container_config.Cmd.join(' ');
                }
                var entry = {
                    Id: img.digest || img.docker_id,
                    Created: img.created,
                    CreatedBy: createdBy,
                    Size: img.size
                };
                history.push(entry);
                tagsForImage(img, opts, function (tagErr, imgTags) {
                    if (imgTags) {
                        entry.Tags = imgTags.map(function _imgTagsMap(it) {
                            return it.repo + ':' + it.tag;
                        });
                    }
                    next();
                });
            }
        }, function (pipeErr) {
            if (pipeErr) {
                callback(pipeErr);
                return;
            }

            if (isV1Image(opts.img)) {
                callback(null, history);
                return;
            }

            // The V2 image has the full history on the ImageV2 instance, so use
            // that history info to fill in any blanks (missing images).
            var imgHist = opts.img.history;
            if (imgHist.length > history.length) {
                imgHist.slice(0, -(history.length)).reverse().map(function (h) {
                    history.push({
                        Id: '<missing>',
                        Comment: h.comment || '',
                        // Created needs to be epoch time in seconds, currenty:
                        //   "2016-10-07T21:03:58.16783626Z"
                        Created: Math.floor(
                            (new Date(h.created)).getTime() / 1000),
                        CreatedBy: h.created_by,
                        Size: h.size || 0,
                        Tags: null
                    });
                });
            }

            assert.equal(history.length, imgHist.length,
                'History length should be equal');
            callback(null, history);
        });
    });
}


/**
 * Find the special scratch docker image and callback with the image details.
 *
 * @param {Object} opts.req Request object.
 * @param callback {Function} `function (err, img)`
 */
function getScratchImage(req, callback) {
    // Only need to find the image once - it should not change for the life of
    // this process.
    if (gScratchImage !== null) {
        callback(null, gScratchImage);
        return;
    }

    var app = req.app;
    var imgapi = app.imgapi;
    var log = req.log;
    var imageJsonPath = path.normalize(
        __dirname + '/../../../etc/scratch_image.json');
    var imageManifestPath = path.normalize(
        __dirname + '/../../../etc/scratch_image.manifest');
    var imageTarPath = path.normalize(
        __dirname + '/../../../etc/scratch_image.tar');
    var imageStr = fs.readFileSync(imageJsonPath, 'utf8');
    var imageJson = JSON.parse(imageStr);
    var manifestStr = fs.readFileSync(imageManifestPath, 'utf8');
    var manifest = JSON.parse(manifestStr);
    var req_id = req.getId();

    var rat = {
        localName: '',
        index: { name: 'docker.io' }
    };

    // Determine if the scratch image has been imported into IMGAPI.
    var size = 0;
    var layerDigests = manifest.layers.map(function (layer) {
        size += layer.size;
        return layer.digest;
    });
    var imageUuid = imgmanifest.imgUuidFromDockerDigests(layerDigests);
    log.debug({uuid: imageUuid}, 'creating IMGAPI scratch image');

    vasync.pipeline({arg: {}, funcs: [
        imgapiFindScratchImage,
        imgapiCreateScratchImage,
        imgapiImportScratchImage,
        imgapiActivateScratchImage
    ]}, function (err) {
        if (err === true) { /* the signal for an early abort */
            err = null;
        }
        if (err) {
            callback(err);
            return;
        }
        var result = imageJsonToModel();
        callback(null, result);
    });

    function imgapiFindScratchImage(ctx, next) {
        imgapi.getImage(imageUuid, function (err, imgapiImg) {
            if (err) {
                if (err.statusCode === 404) { // no such image
                    next();
                } else {
                    next(err);
                }
                return;
            }
            log.debug('getScratchImage: found scratch image in IMGAPI');
            next(true);  /* early abort */
        });
    }

    function imgapiCreateScratchImage(ctx, next) {
        var opts = {
            layerDigests: layerDigests,
            rat: rat,
            req: req
        };
        log.debug('getScratchImage: creating new scratch image in IMGAPI');
        createImgapiDockerImage(imageJson, opts, function (err) {
            next(err);
        });
    }

    function imgapiImportScratchImage(ctx, next) {
        var opts = {
            'compression': 'none',
            file: imageTarPath,
            headers: { 'x-request-id': req_id },
            uuid: imageUuid
        };
        log.debug('getScratchImage: importing scratch image file into IMGAPI');
        imgapi.addImageFile(opts, next);
    }

    function imgapiActivateScratchImage(ctx, next) {
        var opts = {
            headers: { 'x-request-id': req_id }
        };
        log.debug('getScratchImage: imgapi.activateImage');
        imgapi.activateImage(imageUuid, undefined, opts, next);
    }

    function imageJsonToModel() {
        var manifestDigest = 'sha256' + (new crypto.Hash('sha256')).
            update(manifestStr, 'binary').digest('hex');
        var modelOpts = {
            digest: manifest.config.digest,
            head: true,
            image_uuid: imageUuid,
            manifest_str: manifestStr,
            manifest_digest: manifestDigest,
            size: size
        };
        return dockerImageJsonToModel(imageJson, modelOpts);
    }
}


/* BEGIN JSSTYLED */
/*
 * Exploring `docker rmi ...` behaviour:
 *

$ docker history hello-world
IMAGE               CREATED             CREATED BY                                      SIZE
ef872312fe1b        7 months ago        /bin/sh -c #(nop) CMD [/hello]                  0 B
7fa0dcdc88de        7 months ago        /bin/sh -c #(nop) ADD file:e524d9aa2d2d2b65c5   910 B
511136ea3c5a        23 months ago

 *
 * - Docker: if a container is using that image, don't delete it.
 *   SDC: We don't *need* to have that requirement. We can remove an image for
 *   future provs, but current containers are fine. However, for now we'll
 *   match that behaviour.
 *

$ docker rmi hello-world
Error response from daemon: Conflict, cannot delete ef872312fe1b because the container 32a4a48c4b89 is using it, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - '-f' will force remove that image even if a *stopped* container is using
 *   it. It won't force remove an image with a *running* container using it.
 *
 *   TODO(trentm): Not sure this is accurate with subsequent 1.6.0 testing.
 *      I was able to untag, but not delete the image id if there was a
 *      stopped container.
 *

$ docker rmi -f hello-world
Untagged: hello-world:latest
Deleted: ef872312fe1bbc5e05aae626791a47ee9b032efa8f3bda39cc0be7b56bfe59b9
Deleted: 7fa0dcdc88de9c8a856f648c1f8e0cf8141a505bbddb7ecc0c61f1ed5e086852

 *
 * - Note that the previous delete did not remove the 511136ea3c5a image
 *   because it is used by other images.
 *
 * - Now that the image was force removed, in Docker-docker I can't start that
 *   container
 *

$ docker start 32a4a48c4b89
Error response from daemon: Cannot start container 32a4a48c4b89: Error getting container 32a4a48c4b8946bbf087930f5df9d55bed55ec2afa2d9cad16abb304edc11e5d from driver aufs: invalid argument
FATA[0000] Error: failed to start one or more containers

 *
 * - If there are other tags on the image, then just untag it:
 *

$ docker rmi ef
Untagged: ef:latest

 *
 * - Can't remove images that have children. This is effectively the same
 *   thing as saying "non-head" images, as long as we trust we're keeping
 *   our 'head' info up to date (in the Image model). Docker-docker's error
 *   message leaves something to be desired. We'll do a little better.
 *

$ docker rmi b2eda1f5dec1
Error response from daemon: Conflict, b2eda1f5dec1 wasn't deleted
FATA[0000] Error: failed to remove one or more images

 *
 * - Deleting by imgId will will untag *all image tags to that id.
 *

$ docker rmi 156401cf89a1
Untagged: postgres:9.1
Untagged: postgres:9.1.14
Deleted: 156401cf89a1e3486dfd2468aa55d807584ccdc6e122dc07fa0a7d1ddefd80e5
...
Deleted: 7ac189b455b8fd7704dde3cff6fcf940900c343e63c1d92558592959ce1a28aa

*
*    Unless that is tagged for separate repositories.
*

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker images
REPOSITORY                    TAG                 IMAGE ID            CREATED             VIRTUAL SIZE
165.225.157.24:5001/busybox   latest              8c2e06607696        4 weeks ago         2.433 MB
localhost:5001/busybox        latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       trent               8c2e06607696        4 weeks ago         2.433 MB

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker rmi 8c2e06607696
Error response from daemon: Conflict, cannot delete image 8c2e06607696 because it is tagged in multiple repositories, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - TODO: Support 'noprune' option.
 */
/* END JSSTYLED */
function _deleteImageV1(opts, callback) {
    var DRY_RUN = false; // for development use only
    var app = opts.app;
    var dontDeleteImages = false; // Used when we just want to untag the image.
    var log = opts.log;
    var vmapi = getVmapiClient(app.config.vmapi);

    var changes = [];

    vasync.pipeline({arg: opts, funcs: [
        ensureIsHeadImage,
        getImgTags,
        checkTagReferences,
        verifyNotInUse,
        getImgsToDelete,
        getDatacenterRefcount,
        untagHeads,
        deleteImgs
    ]}, function (err) {
        callback(err, changes);
    });

    function ensureIsHeadImage(ctx, cb) {
        if (ctx.img.head !== true) {
            var heads = ctx.img.heads.map(function (imgId) {
                return imgId.substr(0, 12);
            }).join(', ');
            var message = format('Conflict, %s wasn\'t deleted because it '
                + 'is an intermediate layer being referenced by %s',
                ctx.img.docker_id.substr(0, 12), heads);
            cb(new errors.DockerError(message));
        } else {
            cb();
        }
    }

    function getImgTags(ctx, cb) {
        /*
         * This is a head image, but we don't have an imgTag for it: IOW it
         * was named by imgId. Find all imgTags for this guy for untagging.
         *
         * Note: if there are tags from more than one repository, then we
         * should error out (see TODO above).
         */
        tagsForImage(ctx.img, {app: app, log: log, account: opts.account},
                function (err, imgTags) {
            if (err) {
                cb(err);
                return;
            }
            ctx.imgTags = imgTags;
            cb();
        });
    }

    function checkTagReferences(ctx, cb) {
        // When an id (or prefix) is supplied, we can only remove the image if:
        //   1) force is true, or
        //   2) there is only one tag (or less) referencing this image
        // else we can only remove the given tag (when the tag name is supplied)
        // leaving the image (and any other tags) there.
        log.debug({docker_id: ctx.img.docker_id, givenName: opts.name,
            imgTags: ctx.imgTags}, 'deleteImage: checkTagReferences');
        var givenName = opts.name;
        if (ctx.img.docker_id.substr(0, givenName.length) === givenName) {
            if (!opts.force && ctx.imgTags.length > 1) {
                cb(new errors.DockerError(format('conflict: unable to delete '
                    + '%s (must be forced) - image is referenced in one or '
                    + 'more repositories', givenName)));
                return;
            }
        } else if (ctx.imgTags.length > 1) {
            // When a tag name is provided, if there are more than one tags we
            // just want to untag the given one and leave the image and other
            // tags still there.
            assert.object(ctx.imgTag, 'ctx.imgTag');
            dontDeleteImages = true;
            ctx.imgTags = [ctx.imgTag];
        }
        cb();
    }

    function verifyNotInUse(ctx, cb) {
        if (dontDeleteImages) {
            cb();
            return;
        }

        // If force === false this function will return an error if there is at
        // least a running or stopped VM using the image.
        // If force === true, it will return an error if there is at least a
        // running VMusing the image
        var query = {
            docker: true,
            state: (opts.force ? 'running' : 'active'),
            image_uuid: ctx.img.image_uuid,
            owner_uuid: opts.account.uuid
        };

        vmapi.listVms(query, {
            headers: {'x-request-id': opts.req_id}
        }, function (vmapiErr, vms) {
            if (vmapiErr) {
                cb(errors.vmapiErrorWrap(vmapiErr,
                    'could not delete image'));
                return;
            } else if (vms.length === 0) {
                cb();
                return;
            }

            vms.sort(function (a, b) {
                if (a.state < b.state)
                    return -1;
                if (a.state > b.state)
                    return 1;
                return 0;
            });

            var forceStr = opts.force ? 'force ' : '';
            var messageFormat;
            // If the vm is state=incomplete, we might not have
            // internal_metadata.
            var sId = utils.vmUuidToShortDockerId(vms[0].uuid);
            if (vms[0].state === 'running') {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the running container %s is using it, stop it and '
                    + 'use -f to force';
            } else {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the container %s is using it, use -f to force';
            }
            var message = format(messageFormat, forceStr,
                opts.name, sId);

            cb(new errors.DockerError(message));
        });
    }

    function getImgsToDelete(ctx, cb) {
        getImageAncestry({
            app: app,
            log: log,
            img: ctx.img,
            account: opts.account
        }, function (err, history, isPartialHistory) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
            } else {
                if (isPartialHistory) {
                    /*
                     * If we got a partial history, then carry on with the
                     * delete. We don't want missing ancestry (e.g. due to
                     * DOCKER-709) to block the user from deleting this
                     * image.
                     *
                     * Only avenues to client-side output are 'Untagged' and
                     * 'Deleted' keys.
                     */
                    log.warn({err: err, docker_id: ctx.img.docker_id},
                        'deleteImage: getImgsToDelete: partial history');
                    changes.push({ Deleted: format(
                        'warning: %s missing some history: %s',
                        opts.name, err) });
                    ctx.imgsToDelete = history;
                    cb();
                }
                ctx.imgsToDelete = history;
                cb();
            }
        });
    }

    // Get all images that are ready to be deleted from IMGAPI.
    function getDatacenterRefcount(ctx, cb) {
        var params = {
            index_name: ctx.img.index_name,
            docker_id: ctx.img.docker_id,
            limit: 1
        };
        Image.datacenterRefcount(app, log, params, function (err, count) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            ctx.dcRefcount = count;
            cb();
        });
    }

    function untagHeads(ctx, cb) {
        log.debug({imgTags: ctx.imgTags}, 'deleteImage: untagHeads');

        vasync.forEachPipeline({
            inputs: ctx.imgTags,
            func: function untagOne(imgTag, nextImgTag) {
                if (DRY_RUN) {
                    changes.push({ Untagged: imgTag.repo + ':' + imgTag.tag });
                    nextImgTag();
                    return;
                }
                ImageTag.del(app, log, imgTag, function (err) {
                    if (err) {
                        nextImgTag(err);
                    } else {
                        changes.push({
                            Untagged: imgTag.repo + ':' + imgTag.tag });
                        nextImgTag();
                    }
                });
            }
        }, cb);
    }

    function deleteImgs(ctx, cb) {
        if (dontDeleteImages) {
            cb();
            return;
        }

        vasync.forEachPipeline({
            inputs: ctx.imgsToDelete,
            func: deleteOneImg
        }, function (err) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            cb();
        });

        /*
         * `true` if we hit `ImageHasDependentImagesError` error from IMGAPI,
         * in which case we'll not bother attempting to delete further b/c
         * they'll hit the same error.
         */
        var hitImageHasDependentImagesError = false;

        /*
         * We only remove the image *ref* when it is no longer being
         * used by the account. If this is the last usage of the image
         * across the whole DC (dcRefcount===1), then actually delete
         * from IMGAPI.
         */
        function deleteOneImg(img, nextImg) {
            log.debug({imgId: img.docker_id, indexName: img.index_name},
                'deleteImage: deleteOneImg');
            if (DRY_RUN) {
                changes.push({ Deleted: img.docker_id });
                nextImg();
                return;
            }

            if (img.refcount > 1) {
                log.debug({imgId: img.docker_id, indexName: img.index_name},
                    'deleteImage: remove %s from heads', ctx.img.docker_id);
                var update = {
                    owner_uuid: img.owner_uuid,
                    index_name: img.index_name,
                    docker_id: img.docker_id,
                    // Update:
                    heads: img.params.heads.filter(function (id) {
                        return id !== ctx.img.docker_id;
                    })
                };
                if (img.docker_id === ctx.img.docker_id) {
                    /*
                     * The Docker image being removed must no longer be
                     * marked as a 'head', else it could be "deleted again"...
                     * during which `dcRefcount` values are not valid. This
                     * is DOCKER-709.
                     */
                    update.head = false;
                }
                Image.update(app, log, update, nextImg);
            } else {
                log.debug({imgId: img.docker_id, indexName: img.index_name},
                    'deleteImage: delete image', ctx.img.docker_id);
                Image.del(app, log, img, function (delErr) {
                    if (delErr) {
                        nextImg(delErr);
                        return;
                    }

                    changes.push({ Deleted: img.docker_id });

                    var isLastRef = (ctx.dcRefcount[img.docker_id]
                                            !== undefined);
                    if (!isLastRef || hitImageHasDependentImagesError) {
                        nextImg();
                        return;
                    }

                    log.debug({imgUuid: img.image_uuid},
                        'deleteImage: delete imgapi image (last ref)');
                    app.imgapi.deleteImage(img.image_uuid, {
                        headers: {'x-request-id': opts.req_id}
                    }, function (err) {
                        if (err && err.restCode === 'ImageHasDependentImages') {
                            hitImageHasDependentImagesError = true;
                            log.info({imgUuid: img.image_uuid},
                                'deleteImage: hit ImageHasDependentImages');
                            err = null;
                        }
                        nextImg(err);
                    });
                });
            }
        }
    }
}


/* BEGIN JSSTYLED */
/*
 * Exploring `docker rmi ...` behaviour:
 *

$ docker history hello-world
IMAGE               CREATED             CREATED BY                                      SIZE
ef872312fe1b        7 months ago        /bin/sh -c #(nop) CMD [/hello]                  0 B
7fa0dcdc88de        7 months ago        /bin/sh -c #(nop) ADD file:e524d9aa2d2d2b65c5   910 B
511136ea3c5a        23 months ago

 *
 * - Docker: if a container is using that image, don't delete it.
 *   SDC: We don't *need* to have that requirement. We can remove an image for
 *   future provs, but current containers are fine. However, for now we'll
 *   match that behaviour.
 *

$ docker rmi hello-world
Error response from daemon: Conflict, cannot delete ef872312fe1b because the container 32a4a48c4b89 is using it, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - '-f' will force remove that image even if a *stopped* container is using
 *   it. It won't force remove an image with a *running* container using it.
 *
 *   TODO(trentm): Not sure this is accurate with subsequent 1.6.0 testing.
 *      I was able to untag, but not delete the image id if there was a
 *      stopped container.
 *

$ docker rmi -f hello-world
Untagged: hello-world:latest
Deleted: ef872312fe1bbc5e05aae626791a47ee9b032efa8f3bda39cc0be7b56bfe59b9
Deleted: 7fa0dcdc88de9c8a856f648c1f8e0cf8141a505bbddb7ecc0c61f1ed5e086852

 *
 * - Note that the previous delete did not remove the 511136ea3c5a image
 *   because it is used by other images.
 *
 * - Now that the image was force removed, in Docker-docker I can't start that
 *   container
 *

$ docker start 32a4a48c4b89
Error response from daemon: Cannot start container 32a4a48c4b89: Error getting container 32a4a48c4b8946bbf087930f5df9d55bed55ec2afa2d9cad16abb304edc11e5d from driver aufs: invalid argument
FATA[0000] Error: failed to start one or more containers

 *
 * - If there are other tags on the image, then just untag it:
 *

$ docker rmi ef
Untagged: ef:latest

 *
 * - Can't remove images that have children. This is effectively the same
 *   thing as saying "non-head" images, as long as we trust we're keeping
 *   our 'head' info up to date (in the Image model). Docker-docker's error
 *   message leaves something to be desired. We'll do a little better.
 *

$ docker rmi b2eda1f5dec1
Error response from daemon: Conflict, b2eda1f5dec1 wasn't deleted
FATA[0000] Error: failed to remove one or more images

 *
 * - Deleting by imgId will will untag *all image tags to that id.
 *

$ docker rmi 156401cf89a1
Untagged: postgres:9.1
Untagged: postgres:9.1.14
Deleted: 156401cf89a1e3486dfd2468aa55d807584ccdc6e122dc07fa0a7d1ddefd80e5
...
Deleted: 7ac189b455b8fd7704dde3cff6fcf940900c343e63c1d92558592959ce1a28aa

*
*    Unless that is tagged for separate repositories.
*

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker images
REPOSITORY                    TAG                 IMAGE ID            CREATED             VIRTUAL SIZE
165.225.157.24:5001/busybox   latest              8c2e06607696        4 weeks ago         2.433 MB
localhost:5001/busybox        latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       latest              8c2e06607696        4 weeks ago         2.433 MB
busybox                       trent               8c2e06607696        4 weeks ago         2.433 MB

ubuntu@1fd15fd8-e5cd-6ef0-ab35-aae2181b7cd4:~$ docker rmi 8c2e06607696
Error response from daemon: Conflict, cannot delete image 8c2e06607696 because it is tagged in multiple repositories, use -f to force
FATA[0000] Error: failed to remove one or more images

 *
 * - TODO: Support 'noprune' option.
 */
/* END JSSTYLED */
function _deleteImageV2(opts, callback) {
    var DRY_RUN = false; // for development use only
    var app = opts.app;
    var changes = [];
    var dockerId = imgmanifest.dockerIdFromDigest(opts.img.digest);
    var log = opts.log;
    var shortId = imgmanifest.shortDockerId(dockerId);
    var vmapi = getVmapiClient(app.config.vmapi);

    vasync.pipeline({arg: opts, funcs: [
        getImgTags,
        checkTagReferences,
        checkJustUntagImage,
        verifyNotInUse,
        getImgsToDelete,
        deleteDockerTags,
        deleteImgapiLayers,
        deleteDockerImages
    ]}, function (err) {
        if (err === true) {
            // Early abort marker.
            err = null;
        }
        callback(err, changes);
    });

    function getImgTags(ctx, cb) {
        tagsForImage(ctx.img, {app: app, log: log, account: opts.account},
                function (err, imgTags) {
            if (err) {
                cb(err);
                return;
            }
            ctx.imgTags = imgTags;
            cb();
        });
    }

    function checkTagReferences(ctx, cb) {
        // If there are multiple tags for this image, and the image was found
        // using the digest (or digest prefix), we can only remove the image if
        // force is set to true.
        //
        // Note: ctx.imgTag is only set if the image was found using the name
        // and not the digest.
        log.debug({digest: ctx.img.digest, givenName: opts.name,
            imgTags: ctx.imgTags}, 'deleteImage: checkTagReferences');
        if (!ctx.imgTag && !opts.force && ctx.imgTags.length > 1) {
            cb(new errors.DockerError(format('conflict: unable to delete '
                + '%s (must be forced) - image is referenced in one or '
                + 'more repositories', shortId)));
            return;
        }
        cb();
    }

    function checkJustUntagImage(ctx, cb) {
        // When a tag name is provided, if there are multiple tags for this
        // image we just want to untag the given one and leave the image and
        // other tags still there.
        //
        // Note: ctx.imgTag is only set if the image was found using the name
        // and not the digest.
        if (ctx.imgTag && ctx.imgTags.length > 1) {
            if (DRY_RUN) {
                changes.push({
                    Untagged: ctx.imgTag.repo + ':' + ctx.imgTag.tag });
                cb(true);
                return;
            }
            ImageTagV2.del(app, log, ctx.imgTag, function (err) {
                if (err) {
                    cb(err);
                } else {
                    changes.push({
                        Untagged: ctx.imgTag.repo + ':' + ctx.imgTag.tag });
                    // Early abort - nothing more to do here.
                    cb(true);
                }
            });
            return;
        }
        cb();
    }

    function verifyNotInUse(ctx, cb) {
        // If force === false this function will return an error if there is at
        // least a running or stopped VM using the image.
        // If force === true, it will return an error if there is at least a
        // running VMusing the image
        var query = {
            docker: true,
            state: (opts.force ? 'running' : 'active'),
            image_uuid: ctx.img.image_uuid,
            owner_uuid: opts.account.uuid
        };

        vmapi.listVms(query, {
            headers: {'x-request-id': opts.req_id}
        }, function (vmapiErr, vms) {
            if (vmapiErr) {
                cb(errors.vmapiErrorWrap(vmapiErr,
                    'could not delete image'));
                return;
            } else if (vms.length === 0) {
                cb();
                return;
            }

            vms.sort(function (a, b) {
                if (a.state < b.state)
                    return -1;
                if (a.state > b.state)
                    return 1;
                return 0;
            });

            var forceStr = opts.force ? 'force ' : '';
            var messageFormat;
            // If the vm is state=incomplete, we might not have
            // internal_metadata.
            var sId = utils.vmUuidToShortDockerId(vms[0].uuid);
            if (vms[0].state === 'running') {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the running container %s is using it, stop it and '
                    + 'use -f to force';
            } else {
                messageFormat = 'Conflict, cannot %sdelete %s because '
                    + 'the container %s is using it, use -f to force';
            }
            var message = format(messageFormat, forceStr,
                opts.name, sId);

            cb(new errors.DockerError(message));
        });
    }

    function getImgsToDelete(ctx, cb) {
        getImageAncestry({
            app: app,
            log: log,
            img: ctx.img,
            account: opts.account
        }, function (err, ancestry) {
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }

            // Note: Don't delete an ancestor that is a head image.
            var headFound = false;
            ctx.imgsToDelete = [ancestry[0]].concat(ancestry.slice(1).
                filter(function (_img) {
                    headFound = headFound || _img.head;
                    if (headFound) {
                        return false;
                    }
                    return true;
                }
            ));
            cb();
        });
    }

    function deleteDockerTags(ctx, cb) {
        log.debug({imgTags: ctx.imgTags}, 'deleteImage: deleteDockerTags');

        vasync.forEachPipeline({
            inputs: ctx.imgTags,
            func: function untagOne(imgTag, nextImgTag) {
                if (DRY_RUN) {
                    changes.push({ Untagged: imgTag.repo + ':' + imgTag.tag });
                    nextImgTag();
                    return;
                }
                ImageTagV2.del(app, log, imgTag, function (err) {
                    if (err) {
                        nextImgTag(err);
                    } else {
                        changes.push({
                            Untagged: imgTag.repo + ':' + imgTag.tag });
                        nextImgTag();
                    }
                });
            }
        }, cb);
    }

    function deleteImgapiLayers(ctx, cb) {
        // Check the image layers in IMGAPI, if they are no longer referenced
        // anywhere in the DC then the IMGAPI layer should be deleted.
        var manifest;
        try {
            manifest = JSON.parse(ctx.img.manifest_str);
        } catch (e) {
            log.error({img: ctx.img}, 'Unable to parse image manifest_str');
            cb(new errors.DockerError(e,
                format('Unable to parse image manifest_str for image %s',
                ctx.img.digest)));
            return;
        }

        // Note that multiple images in the ancestry can reference the same
        // IMGAPI uuid (i.e. a metadata layer change will have the same IMGAPI
        // uuid as it's parent, as it has the same underlying filesystem bits).
        var ownUuidRefCount = {};
        ctx.imgsToDelete.forEach(function (img) {
            ownUuidRefCount[img.image_uuid] =
                1 + (ownUuidRefCount[img.image_uuid] || 0);
        });

        var hitImageHasDependentImagesError = false;
        var diffIds = ctx.img.rootfs.diff_ids;
        assert.equal(diffIds.length, manifest.layers.length,
            'diff_ids length and manifest.layers length must be equal');

        var layerDigests = [];
        var layerInfos = manifest.layers.map(
            function (layer, idx) {
                layerDigests.push(layer.digest);
                return {
                    layerDigest: layer.digest,
                    diffId: diffIds[idx],
                    uuid: imgmanifest.imgUuidFromDockerDigests(layerDigests)
                };
            }
        );

        // Delete the images in reverse order (i.e. base layer is deleted last).
        vasync.forEachPipeline({
            func: deleteLayer,
            inputs: layerInfos.reverse()
        }, cb);

        function deleteLayer(layerInfo, nextLayer) {
            if (hitImageHasDependentImagesError) {
                nextLayer();
                return;
            }

            var layerDigest = layerInfo.layerDigest;
            var uuid = layerInfo.uuid;

            // Ensure no other docker image uses this *layer* in the *DC*.
            var filter = [ { image_uuid: uuid } ];
            ImageV2.list(opts.app, log, filter, function (lookupErr, imgs) {
                if (lookupErr) {
                    nextLayer(lookupErr);
                    return;
                }

                var imageRefCnt = imgs.length;
                // The image ancestry *may* include a reference to this layer,
                // so negate the image's own reference in that case.
                if (ownUuidRefCount[uuid]) {
                    imageRefCnt -= 1;
                    ownUuidRefCount[uuid] -= 1;
                }
                if (imageRefCnt >= 1) {
                    // This image is referenced by another docker image.
                    log.debug({layerDigest: layerDigest, refCnt: imageRefCnt,
                        uuid: uuid}, 'deleteLayer: not deleting - '
                        + 'layer is referenced by other images');
                    // TODO: Should we add a 'Deleted' changes entry here? We
                    // would need to check that these other referencing images
                    // are not owned by this user.
                    hitImageHasDependentImagesError = true;
                    nextLayer();
                    return;
                }

                // No other docker image references this layer - try and delete
                // it from IMGAPI.
                log.debug({layerDigest: layerDigest, uuid: uuid},
                    'deleteLayer: deleting IMGAPI layer');
                if (DRY_RUN) {
                    changes.push({ Deleted: layerInfo.diffId });
                    nextLayer();
                    return;
                }
                app.imgapi.deleteImage(uuid, {
                    headers: {'x-request-id': opts.req_id}
                }, function (err) {
                    if (err && err.restCode === 'ImageHasDependentImages') {
                        // This origin is used by another IMGAPI image.
                        hitImageHasDependentImagesError = true;
                        log.info({layerDigest: layerDigest, uuid: uuid},
                            'deleteLayer: hit ImageHasDependentImages');
                        err = null;
                    } else if (!err) {
                        changes.push({ Deleted: layerInfo.diffId });
                    }
                    nextLayer(err);
                });
            });
        }
    }

    function deleteDockerImages(ctx, cb) {
        vasync.forEachPipeline({
            inputs: ctx.imgsToDelete,
            func: deleteOneImg
        }, function (err) {
            if (err === true) {
                // Early abort - no error.
                err = null;
            }
            if (err) {
                cb(new errors.DockerError(err, 'could not delete image'));
                return;
            }
            cb();
        });

        /**
         * Delete up the ancestor chain.
         */
        function deleteOneImg(img, nextImg) {
            if (img.digest !== ctx.img.digest) {
                assert.equal(img.head, false, 'img.head should be false');
            }

            log.debug({digest: img.digest}, 'deleteImage: deleteOneImg');
            if (DRY_RUN) {
                changes.push({ Deleted: img.digest });
                nextImg();
                return;
            }

            ImageV2.del(app, log, img, function (delErr) {
                if (delErr) {
                    nextImg(delErr);
                    return;
                }

                changes.push({ Deleted: img.digest });
                nextImg();
            });
        }
    }
}


function deleteImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalObject(opts.app, 'opts.app');
    assert.bool(opts.force, 'opts.force');
    assert.optionalObject(opts.log, 'opts.log');
    assert.string(opts.name, 'opts.name');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.account, 'opts.account');

    var changes;
    var log = opts.log;

    log.debug({imgName: opts.name}, 'deleteImage');

    vasync.pipeline({funcs: [
        getImg,
        doDeleteImage
    ]}, function (err) {
        callback(err, changes);
    });


    function getImg(_, cb) {
        imgFromName(opts, function (err, img, imgTag) {
            if (err) {
                cb(err);
            } else if (!img) {
                cb(new errors.ResourceNotFoundError(
                    'No such image: ' + opts.name));
            } else {
                log.debug({img: img, imgTag: imgTag}, 'deleteImage: getImg');
                opts.img = img;
                if (imgTag) {
                    // Only set if `name` was not an imgId.
                    opts.imgTag = imgTag;
                }
                cb();
            }
        });
    }

    function doDeleteImage(_, cb) {
        if (isV1Image(opts.img)) {
            _deleteImageV1(opts, function (err, _changes) {
                changes = _changes;
                cb(err);
            });
        } else {
            _deleteImageV2(opts, function (err, _changes) {
                changes = _changes;
                cb(err);
            });
        }
    }
}


/**
 * Inspect an image.
 *
 * @param name {String} An imgId, imgId prefix, or image [REG/]NAME[:TAG] to
 *      inspect.
 * ...
 */
function inspectImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.account, 'opts.account');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.log, 'opts.log');
    assert.optionalString(opts.index_name, 'opts.index_name'); // For ImageV1.

    imgFromName(opts, function (err, img) {
        if (err) {
            callback(err);
        } else if (!img) {
            callback(new errors.ResourceNotFoundError(
                'No such image: ' + opts.name));
        } else {
            // Get tags and return inspect info.
            tagsForImage(img, opts, function _getImgTagsCb(err2, imgTags) {
                if (err2) {
                    callback(err2);
                    return;
                }
                var inspect = utils.imgobjToInspect(img, imgTags);
                callback(null, inspect, img);
            });
        }
    });
}


function pullImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.rat, 'opts.rat');  // rat === Repo And Tag/Digest
    assert.object(opts.req, 'opts.req');
    assert.string(opts.req_id, 'opts.req_id');
    assert.object(opts.res, 'opts.res');
    assert.object(opts.wfapi, 'opts.wfapi');
    assert.object(opts.account, 'opts.account');

    var jobUuid;

    /*
     * Handle a pull error. This is a chunked transfer so we can't return
     * a restify error because headers have already been sent when the
     * downloads have started. "docker/pkg/jsonmessage/jsonmessage.go" defines
     * an error message format.
     *
     * In general we can't assume much about the `err` object, e.g. if it
     * is an early failure. However, we try to gracefully handle some
     * well structured cases.
     *
     * 1. In some cases the `err.code` is set to a meaningful error code.
     *    This comes via the `JOB.chain_results[-1].error.name`, set by
     *    pull-image.js error handling. Note that some older versions of IMGAPI
     *    can send back docker-registry-client errors (as well as IMGAPI errors)
     *    that have a different err.code string (drc code will use an extra
     *    `Error` suffix on the err.code).
     * 2. If there is an error in the Docker Registry v2 API, then `err.message`
     *    equals a JSON string per:
     *        https://docs.docker.com/registry/spec/api/#errors
     */
    function errorAndEnd(err, job) {
        assert.object(err, 'err');

        var imgName = opts.rat.localName;
        if (opts.rat.digest) {
            imgName += '@' + opts.rat.digest;
        } else if (opts.rat.tag) {
            imgName += ':' + opts.rat.tag;
        }
        opts.req.log.info({err: err, imgName: imgName,
            jobUuid: job && job.uuid}, 'imageCreate job error');

        /*
         * `recognized: false` is log.info'd below to indicated `docker pull`
         * errors that are ones that we are *not* handling specially and
         * falling back to "Error pulling image: Internal error". I.e. the
         * point is to get back to those and improve the user experience.
         */
        var recognized = true;

        var errmsg;
        if (
            /*
             * `RemoteSourceError` code comes from newer IMGAPI.
             * `ENOTFOUND` code comes from docker-registry-client - through
             * old IMGAPI versions.
             */
            err.code === 'RemoteSourceError' || err.code === 'ENOTFOUND')
        {
            /* BEGIN JSSTYLED */
            /*
             * Docker-docker:
             *  $ docker pull nope.example.com/nope
             *  Using default tag: latest
             *  Error response from daemon: Get https://nope.example.com/v1/_ping: dial tcp: lookup nope.example.com on 192.168.65.1:53: no such host
             *
             * Triton-docker:
             *  $ docker --tls pull nope.example.com/nope
             *  Using default tag: latest
             *  Pulling repository nope.example.com/nope
             *  Error pulling image: (ENOTFOUND) nope.example.com host not found
             *
             * err={ [Error: getaddrinfo ENOTFOUND] code: 'ENOTFOUND' }
             */
            /* END JSSTYLED */
            errmsg = format('Error pulling image: (%s) %s host not found',
                err.code, opts.rat.index.name);
        } else if (
            /*
             * --- UnauthorizedError
             * Docker-docker:
             *  $ docker pull trentm/busybox-i-am-in-you
             *  Using default tag: latest
             *  Pulling repository docker.io/trentm/busybox-i-am-in-you
             *  Error: image trentm/busybox-i-am-in-you:latest not found
             *
             * --- ResourceNotFoundError
             * E.g.: `docker pull quay.io/no-such-user`
             */
            err.code === 'UnauthorizedError' || /* newer IMGAPI */
            err.code === 'UNAUTHORIZED' || /* older IMGAPI */
            err.code === 'ResourceNotFound' || /* newer IMGAPI */
            err.code === 'NotFoundError')      /* older IMGAPI */
        {
            errmsg = format('Error: image %s not found', imgName);
        } else if (
            /*
             * `Download` code comes from newer IMGAPI.
             * `DownloadError` code comes from docker-registry-client - through
             * old IMGAPI versions.
             */
            err.code === 'Download' || err.code === 'DownloadError')
        {
            errmsg = format('Error downloading %s: %s', imgName, err.message);
        } else if (
            /*
             * `RemoteSourceError` code comes from newer IMGAPI.
             * `ConnectTimeoutError` code comes from docker-registry-client -
             * through old IMGAPI versions.
             */
            err.code === 'ConnectTimeoutError'
            || err.code === 'RemoteSourceError')
        {
            errmsg = format('Timeout connecting to host %s',
                opts.rat.index.name);
        } else if (err.code === 'NotImplemented') {
            // E.g. OAuth auth to a Docker Registry before DOCKER-771.
            errmsg = format('Could not pull from registry %s: %s',
                opts.rat.index.name, err.message);
        } else {
            /*
             * E.g.: {"errors":[{"code":"UNAUTHORIZED",
             *   "message":"authentication required",
             *   "detail":[{"Type":"repository","Name":"library/no-such",
             *      "Action":"pull"}]}]}
             */
            var regErr;
            try {
                regErr = JSON.parse(err.message);
            } catch (e) {
                /* pass */
            }
            if (!regErr || !regErr.errors) {
                recognized = false;
                errmsg = 'Error pulling image: Internal error';
            } else if (regErr.errors.length === 1) {
                var code = regErr.errors[0].code;
                if (code === 'MANIFEST_UNKNOWN') {
                    /*
                     * An *unknown repo* in a Docker registry will yield:
                     *      message.errors[0].code === 'MANIFEST_UNKNOWN'
                     * Per DOCKER-639, Docker-docker responds with:
                     *      Error: image hello-world:latest not found
                     */
                    errmsg = format('Error: image %s not found', imgName);
                } else {
                    errmsg = format('Error pulling image: (%s) %s',
                        code, regErr.errors[0].message);
                }
            } else {
                var errmsgs = regErr.errors.map(function (e) {
                    return format('(%s) %s', e.code, e.message); })
                    .join(', ');
                errmsg = format('Error pulling image: %s', errmsgs);
            }
        }

        opts.req.log.info({err: err, imgName: imgName,
            jobUuid: job && job.uuid, recognized: recognized, errmsg: errmsg},
            'pullImage error');

        /*
         * Note: docker/pkg/jsonmessage/jsonmessage.go describes an optional
         * 'errorDetail.code' field, though I don't know specific usage of
         * this in Docker-'docker pull'.
         */
        errmsg += ' (' + opts.req_id + ')';
        var payload = {
            error: errmsg,  // deprecated field
            errorDetail: {
                message: errmsg
            }
        };

        opts.res.write(JSON.stringify(payload));
        opts.res.end();
    }

    vasync.pipeline({
        funcs: [
            createPullJob,
            waitForPullJob
        ]
    }, callback);

    function createPullJob(_, next) {
        var jobOpts = {
            rat: opts.rat,
            req_id: opts.req_id,
            account: opts.account,
            regAuth: opts.req.headers['x-registry-auth'],
            regConfig: opts.req.headers['x-registry-config']
        };

        opts.wfapi.createPullImageV2Job(jobOpts, function (err, juuid) {
            if (err) {
                errorAndEnd(err);
                next();
                return;
            }

            jobUuid = juuid;

            // Create an in-progress pull operation so the wfapi job can report
            // progress back to us
            opts.app.sockets.setSocket('job', opts.rat.canonicalName, {
                socket: opts.res
            });

            next();
        });
    }

    function waitForPullJob(_, next) {
        common.waitForJob(opts.wfapi, jobUuid, function (err, job) {
            if (err) {
                errorAndEnd(err, job);
            }

            next();
        });
    }
}


/**
 * Create new (unactivated) docker image in imgapi and return it through the
 * callback.
 */
function createImgapiDockerImage(imageJson, opts, callback) {
    assert.object(opts, 'opts');
    assert.optionalString(opts.account_uuid, 'opts.account_uuid');
    assert.arrayOfString(opts.layerDigests, 'opts.layerDigests');
    assert.object(opts.rat, 'opts.rat');
    assert.object(opts.req, 'opts.req');

    opts.req.log.debug('opts.rat: ', opts.rat);
    var manifest = imgmanifest.imgManifestFromDockerInfo({
        layerDigests: opts.layerDigests,
        imgJson: imageJson,
        owner: opts.account_uuid,
        public: false,
        repo: opts.rat
    });
    var imageOpts = {
        headers: { 'x-request-id': opts.req.getId() }
    };
    opts.req.log.debug({manifest: manifest}, 'createImage manifest');
    opts.req.app.imgapi.adminImportImage(manifest, imageOpts,
        function _adminImportImageCb(err, img)
    {
        if (err) {
            callback(err);
            return;
        }
        callback(null, img);
    });
}


/**
 * Tags the given image digest with the given name.
 *
 * Accepted name examples:
 *   busybox
 *   toddw/mybusybox:latest
 *   my.registry.com:5000/ns/myname:head
 *
 * @param opts {Object} Contains image and tag information.
 * @param callback {Function} with signature fn(err, imgTag).
 */
function tagImage(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.name, 'opts.name');
    assert.object(opts.req, 'opts.req');
    assert.optionalString(opts.digest, 'opts.digest');
    assert.optionalObject(opts.img, 'opts.img');
    assert.optionalObject(opts.rat, 'opts.rat');

    var digest = opts.digest;
    var rat = opts.rat;
    var req = opts.req;

    if (!rat) {
        try {
            rat = drc.parseRepoAndTag(opts.name);
        } catch (e) {
            callback(new errors.DockerError(e, e.message));
            return;
        }
    }

    if (!digest) {
        assert.object(opts.img, 'opts.img or opts.digest must be provided');
        if (isV1Image(opts.img)) {
            callback(new errors.DockerError(
                'Cannot tag old v1 images - repull or rebuild the image'));
            return;
        }
        digest = opts.img.digest;
    }

    var params = {
        digest: digest,
        owner_uuid: req.account.uuid,
        repo: rat.localName,
        tag: rat.tag

    };
    ImageTagV2.create(req.app, req.log, params, callback);
}


/**
 * Whether img is an instance of models.images.Image (aka v1 image).
 */
function isV1Image(img) {
    return !img.hasOwnProperty('manifest_str');
}


function getImageCount(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');
    assert.optionalObject(opts.log, 'opts.log');
    assert.object(opts.account, 'opts.account');

    Image.imageCount(opts.app, opts.log, {owner_uuid: opts.account.uuid},
        callback);
}


// ---- exports

module.exports = {
    deleteImage: deleteImage,
    dockerImageJsonToModel: dockerImageJsonToModel,
    getImageCount: getImageCount,
    getImageHistory: getImageHistory,
    getScratchImage: getScratchImage,
    isV1Image: isV1Image,
    listImages: listImages,
    inspectImage: inspectImage,
    imgFromImgInfo: imgFromImgInfoV2,
    pullImage: pullImage,
    imgFromDigest: imgFromDigest,
    imgFromName: imgFromName,
    tagImage: tagImage
};
