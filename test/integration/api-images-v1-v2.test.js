/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Test docker images that use v1, v2 or both v1/v2 docker image buckets.
 */

var path = require('path');
var util = require('util');

var drc = require('docker-registry-client');
var imgmanifest = require('imgmanifest');
var libuuid = require('libuuid');
var test = require('tape');
var vasync = require('vasync');

var h = require('./helpers');
var imageV1 = require('../../lib/models/image');
var imageTagV1 = require('../../lib/models/image-tag');
var log = require('../lib/log');


// --- Globals

var ALICE;
var DOCKER_ALICE;
var gInitSuccessful = false;
var gV1Image;
var gV1ImageName = 'joyentunsupported/busybox_with_label_test_v1';
var gV2Image;
var gV2ImageName = 'joyentunsupported/busybox_with_label_test';
var imgapiClient;
var morayClient;
var STATE = {
    log: log
};


// --- Tests


test('setup', function (tt) {

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err);
            ALICE = accounts.alice;
            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE}, function (err, client) {
            t.ifErr(err, 'docker client init');
            DOCKER_ALICE = client;
            t.end();
        });
    });

    tt.test('imgapi client init', function (t) {
        h.createImgapiClient(function (err, client) {
            t.ifErr(err, 'imgapi client init');
            imgapiClient = client;
            t.end();
        });
    });

    tt.test('moray client init', function (t) {
        h.createMorayClient(function (err, client) {
            t.ifErr(err, 'moray client init');
            morayClient = client;
            t.end();
        });
    });
});


/**
 * Create v1 and v2 docker images.
 *
 * To test a v2 image, we simply docker pull it.
 * To test a v1 image, we need to jump through some hoops:
 *  - manually create the IMGAPI image/file
 *  - manually create the v1 image model (docker_images bucket)
 */
test('init docker images', function (tt) {
    var app = {
        moray: morayClient
    };

    tt.test('pull v2 busybox_with_label_test image', function (t) {
        h.ensureImage({
            name: gV2ImageName,
            user: ALICE
        }, function (err) {
            t.error(err, 'should be no error pulling image');
            t.end();
        });
    });

    tt.test('inspect v2 image', function (t) {
        var url = '/images/' + encodeURIComponent(gV2ImageName) + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, img) {
            t.error(err, 'get v2 image');
            gV2Image = img;
            t.end();
        });
    });

    tt.test('create v1 test image', function (t) {
        var imageUuid = libuuid.create();
        var dockerId = (imageUuid + imageUuid).replace(/-/g, '');
        var v1ModelParams = {
            'config': {
                'Cmd': null,
                'Env': null,
                'ExposedPorts': null,
                'Image': ''
            },
            'container_config': {
                'Cmd': null,
                'Env': null,
                'ExposedPorts': null,
                'Image': ''
            },
            'created': Date.now(),
            'docker_id': dockerId,
            'head': true,
            'heads': [dockerId],
            'index_name': 'docker.io',
            'os': 'linux',
            'owner_uuid': ALICE.account.uuid,
            'size': 0,
            'virtual_size': 0
        };

        vasync.pipeline({arg: {}, funcs: [
            imgapiCreateDummyImage,
            imgapiImportDummyImage,
            imgapiActivateDummyImage,
            sdcDockerCreateV1Model,
            sdcDockerCreateV1ModelTag
        ]}, function (err) {
            t.error(err, 'should be no error creating dummy IMGAPI image');
            if (!err) {
                gInitSuccessful = true;
            }
            t.end();
        });

        function imgapiCreateDummyImage(ctx, next) {
            var rat = drc.parseRepoAndTag(gV1ImageName);
            log.debug('dummy: creating dummy image in IMGAPI');

            var manifest = imgmanifest.imgManifestFromDockerInfo({
                imgJson: v1ModelParams,
                layerDigests: ['sha256:' + dockerId],
                owner: ALICE.account.uuid,
                public: false,
                repo: rat
            });
            manifest.uuid = imageUuid; // Keep image_uuid the same.
            log.debug({manifest: manifest}, 'createImage manifest');
            imgapiClient.adminImportImage(manifest, next);
        }

        function imgapiImportDummyImage(ctx, next) {
            var opts = {
                compression: 'none',
                file: path.normalize(
                    __dirname + '/../../etc/scratch_image.tar'),
                uuid: imageUuid
            };
            log.debug('dummy: importing dummy image file into IMGAPI');
            imgapiClient.addImageFile(opts, next);
        }

        function imgapiActivateDummyImage(ctx, next) {
            log.debug('dummy: imgapi.activateImage');
            imgapiClient.activateImage(imageUuid, next);
        }

        function sdcDockerCreateV1Model(ctx, next) {
            log.debug('dummy: sdcdocker.createV1Model');
            v1ModelParams.image_uuid = imageUuid;
            imageV1.create(app, log, v1ModelParams, function (err, img) {
                gV1Image = img;
                next(err);
            });
        }

        function sdcDockerCreateV1ModelTag(ctx, next) {
            log.debug('dummy: sdcdocker.createV1ModelTag');
            var params = {
                docker_id: gV1Image.docker_id,
                index_name: 'docker.io',
                owner_uuid: ALICE.account.uuid,
                repo: gV1ImageName,
                tag: 'latest'
            };
            imageTagV1.create(app, log, params, function (err) {
                next(err);
            });
        }
    });
});


// Ensure v1 and v2 images play nicely together.
test('test docker v1/v2 images', function (tt) {
    if (gInitSuccessful === false) {
        tt.skip('image init failed');
        tt.end();
        return;
    }

    tt.test('list v1/v2 images', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');
            t.ok(images.length >= 2, 'images length >= 2');

            // Check that both the v1 and v2 images are listed.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.ok(v1ImageExists, 'Expect list images to include v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.ok(v2ImageExists, 'Expect list images to include v2 image');

            t.end();
        });
    });

    // Test when the v1 and v2 image have the same name.
    tt.test('tag v2 image with v1 name', function (t) {
        var url = util.format('/images/%s/tag?repo=%s&tag=latest',
            gV2ImageName, gV1ImageName);
        DOCKER_ALICE.post(url, onpost);
        function onpost(err) {
            t.error(err, 'should be no error tagging v2 image');
            t.end();
        }
    });

    tt.test('delete v2 image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV2ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v2 image');
            t.end();
        }
    });

    // Inspect the v1 image name (should give us the newly tagged v2 image).
    tt.test('inspect v2 tagged image', function (t) {
        var url = '/images/' + encodeURIComponent(gV1ImageName) + '/json';
        DOCKER_ALICE.get(url, function (err, req, res, img) {
            t.error(err, 'get v2 tagged image');
            t.equal(img.Id, gV2Image.Id, 'inspect should give the v2 id');
            t.end();
        });
    });

    // Delete the v2 tagged image.
    tt.test('delete v2 tagged image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV1ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v2 tagged image');
            t.end();
        }
    });

    tt.test('ensure v2 image is gone', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');
            t.ok(images.length >= 1, 'images length >= 1');

            // Check that both the v1 image exists and v2 image is gone.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.ok(v1ImageExists, 'Expect list images to include v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.notOk(v2ImageExists, 'Expect list images to exclude v2 image');

            t.end();
        });
    });

    tt.test('delete v1 image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(gV1ImageName), ondel);
        function ondel(err) {
            t.error(err, 'should be no error deleting v1 image');
            t.end();
        }
    });

    tt.test('ensure v1 and v2 images are gone', function (t) {
        DOCKER_ALICE.get('/images/json',
                function (err, req, res, images) {
            t.error(err, 'should be no error retrieving images');
            t.ok(images, 'images array');

            // Check that both the v1 and v2 images are gone.
            var v1ImageExists = images.filter(function (img) {
                return img.Id === gV1Image.docker_id;
            }).length > 0;
            t.notOk(v1ImageExists, 'Expect list images to exclude v1 image');

            var v2ImageExists = images.filter(function (img) {
                return img.Id === gV2Image.Id;
            }).length > 0;
            t.notOk(v2ImageExists, 'Expect list images to exclude v2 image');

            t.end();
        });
    });
});


test('teardown', function (tt) {
    imgapiClient.close();
    morayClient.close();
    tt.end();
});
