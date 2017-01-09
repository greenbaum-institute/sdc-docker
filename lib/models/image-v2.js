/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2017, Joyent, Inc.
 */

/*
 * Image model v2
 *
 * The digest is the sha256 of the 'image JSON' (aka metadata).
 * The image_uuid is the underlying layer (bits) - stored in IMGAPI.
 */

var assert = require('assert-plus');
var format = require('util').format;

var moray = require('../moray');



// --- Globals

var BUCKET = {
    desc: 'docker image v2',
    name: 'docker_images_v2',
    schema: {
        index: {
            digest: { type: 'string' },
            head: { type: 'boolean' },
            image_uuid: { type: 'string' },
            manifest_digest: { type: 'string' },
            owner_uuid: { type: 'string' },
            parent: { type: 'string' }
        }
    },
    version: 1
};



// --- Helpers

function objectKey(params) {
    assert.string(params.digest, 'params.digest');
    assert.string(params.owner_uuid, 'params.owner_uuid');

    return format('%s,%s', params.owner_uuid, params.digest);
}


// --- ImageV2 object


/**
 * ImageV2 model constructor
 */
function ImageV2(params) {
    assert.object(params, 'image params');
    assert.string(params.digest, 'params.digest');
    assert.bool(params.head, 'params.head');
    assert.object(params.image, 'params.image');
    assert.string(params.image_uuid, 'params.image_uuid');
    assert.string(params.manifest_digest, 'params.manifest_digest');
    assert.string(params.manifest_str, 'params.manifest_str');
    assert.optionalString(params.parent, 'params.parent');
    assert.string(params.owner_uuid, 'params.owner_uuid');
    assert.number(params.size, 'params.size');

    // Check that the image is correct.
    var image = params.image;
    assert.object(image.config, 'image.config');
    assert.string(image.created, 'image.created');
    assert.object(image.history, 'image.history');
    assert.string(image.os, 'image.os');
    assert.object(image.rootfs, 'image.rootfs');
    // Optionals
    assert.optionalString(image.architecture, 'image.architecture');
    assert.optionalString(image.author, 'image.author');
    assert.optionalString(image.comment, 'image.comment');
    assert.optionalString(image.container, 'image.container');
    assert.optionalObject(image.container_config, 'image.container_config');
    assert.optionalString(image.docker_version, 'image.docker_version');
    assert.optionalString(image.id, 'image.id');
    assert.optionalString(image.parent, 'image.parent');

    // Params.parent must be set in order to get indexing on parent.
    if (!params.parent && params.image.parent) {
        params.parent = params.image.parent;
    } else if (params.parent) {
        assert.equal(params.parent, params.image.parent,
            'image.parent should equal params.parent');
    }
    // Cleanup parent to ensure it's a string (not null or undefined), this is
    // so we can later search/filter against an empty parent string.
    if (!params.parent) {
        params.parent = '';
    }

    // Validate digests.
    assert.ok(params.digest.indexOf(':') >= 0,
        'digest must include a colon, got ' + params.parent);

    this.params = params;

    // image.created is an ISO timestamp string: "2016-10-07T21:03:58.16783626Z"
    // but some of the docker APIs use a unix timestamp (seconds since 1970), so
    // we create a separate unix timestamp entry from the given ISO timestamp
    // string.
    this.params.created = Math.floor(
        (new Date(this.params.image.created).getTime()) / 1000);

    // Accessor for computing the moray object key
    this.__defineGetter__('key', function () {
        return objectKey(this.params);
    });
    this.__defineGetter__('digest', function () {
        return this.params.digest;
    });
    this.__defineGetter__('head', function () {
        return this.params.head;
    });
    this.__defineGetter__('image', function () {
        return this.params.image;
    });
    this.__defineGetter__('image_uuid', function () {
        return this.params.image_uuid;
    });
    this.__defineGetter__('manifest_str', function () {
        return this.params.manifest_str;
    });
    this.__defineGetter__('manifest_digest', function () {
        return this.params.manifest_digest;
    });
    this.__defineGetter__('owner_uuid', function () {
        return this.params.owner_uuid;
    });
    this.__defineGetter__('size', function () {
        return this.params.size;
    });

    // Backwards compat for older image code.
    this.__defineGetter__('author', function () {
        return this.params.image.author;
    });
    this.__defineGetter__('architecture', function () {
        return this.params.image.architecture;
    });
    this.__defineGetter__('comment', function () {
        return this.params.image.comment;
    });
    this.__defineGetter__('config', function () {
        // Warning: `config` can be null on base Docker images.
        return this.params.image.config;
    });
    this.__defineGetter__('container_config', function () {
        return this.params.image.container_config;
    });
    this.__defineGetter__('created', function () {
        return this.params.created;
    });
    this.__defineGetter__('createdISOString', function () {
        return this.params.image.created;
    });
    this.__defineGetter__('docker_version', function () {
        return this.params.image.docker_version;
    });
    this.__defineGetter__('history', function () {
        return this.params.image.history;
    });
    this.__defineGetter__('parent', function () {
        return this.params.image.parent;
    });
    this.__defineGetter__('private', function () {
        return false;
    });
    this.__defineGetter__('rootfs', function () {
        return this.params.image.rootfs;
    });
}


/**
 * Returns the raw form of the image suitable for storing in moray,
 * which is the same as the serialized form
 */
ImageV2.prototype.toJSON =
    ImageV2.prototype.raw =
    ImageV2.prototype.serialize =
    function ()
{
    return {
        digest: this.params.digest,
        created: this.params.created,
        head: this.params.head,
        image: this.params.image,
        image_uuid: this.params.image_uuid,
        manifest_str: this.params.manifest_str,
        manifest_digest: this.params.manifest_digest,
        parent: this.params.parent,
        owner_uuid: this.params.owner_uuid,
        size: this.params.size
    };
};



// --- Exported functions

/**
 * Creates a image
 */
function createImage(app, log, params, callback) {
    log.debug({ params: params }, 'createImageV2: entry');

    var image = new ImageV2(params);
    app.moray.putObject(BUCKET.name, image.key, image.raw(), function (err) {
        if (err) {
            return callback(err);
        }

        return callback(null, image);
    });
}


/**
 * Lists all images
 */
function listImages(app, log, params, callback) {
    log.debug({params: params}, 'listImagesV2: entry');

    if (!Object.keys(params).length) {
        params = '(digest=*)';
    }

    moray.listObjs({
        filter: params,
        log: log,
        bucket: BUCKET,
        model: ImageV2,
        moray: app.moray
    }, callback);
}


/**
 * Updates an image
 */
function updateImage(app, log, params, callback) {
    log.debug({params: params}, 'updateImageV2: entry');
    var key = objectKey(params);
    moray.updateObj({
        moray: app.moray,
        bucket: BUCKET,
        key: key,
        val: params
    }, function (err, rec) {
        if (err) {
            return callback(err);
        }

        return callback(null, new ImageV2(rec.value));
    });
}


/**
 * Deletes an image
 */
function deleteImage(app, log, params, callback) {
    log.debug({params: params}, 'deleteImageV2: entry');
    var key = objectKey(params);
    moray.delObj(app.moray, BUCKET, key, callback);
}


/**
 * Every funtion should just take care of replacing the column with a new
 * value, or just return if it doesn't apply. When an updated object needs
 * to be written every function should push a new item to the batch array.
 */
var migrations = [
];


/**
 * Initializes the images bucket.
 */
function initImagesBucket(app, callback) {
    moray.initBucket(app.moray, BUCKET, function (err, updated, fromBucket) {
        if (err) {
            callback(err);
            return;
        }

        // Run migrations when the bucket needs to be updated.
        if (updated) {
            moray.migrateObjects({
                app: app,
                bucket: BUCKET,
                fromBucket: fromBucket,
                migrations: migrations
            }, callback);
        } else {
            callback();
        }
    });
}


module.exports = {
    create: createImage,
    del: deleteImage,
    init: initImagesBucket,
    list: listImages,
    ImageV2: ImageV2,
    update: updateImage
};
