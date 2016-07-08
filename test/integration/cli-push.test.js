/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2016, Joyent, Inc.
 */

/*
 * Integration tests for `docker push` using the docker cli.
 */

var path = require('path');

var tarstream = require('tar-stream');
var test = require('tape');
var vasync = require('vasync');

var cli = require('../lib/cli');
var common = require('../lib/common');
var h = require('./helpers');

var format = require('util').format;

var STATE = {
    log: require('../lib/log')
};

var ALICE;
var CONTAINER_PREFIX = 'sdcdockertest_push_';
var DOCKER_ALICE; // Regular JSON restify client.
var IMAGE_NAME = 'busybox';
var TP = 'cli: push: ';  // Test prefix.

test(TP + 'setup', function (tt) {

    tt.test('DockerEnv: alice init', cli.init);

    tt.test('docker env', function (t) {
        h.initDockerEnv(t, STATE, {}, function (err, accounts) {
            t.ifErr(err, 'Initializing docker env');

            ALICE = accounts.alice;

            t.end();
        });
    });

    tt.test('docker client init', function (t) {
        h.createDockerRemoteClient({user: ALICE},
            function (err, client) {
                t.ifErr(err, 'docker client init for alice');
                DOCKER_ALICE = client;
                t.end();
            }
        );
    });

    // Ensure the busybox image is around.
    tt.test(TP + 'pull busybox image', function (t) {
        cli.pull(t, {
            image: 'busybox:latest'
        });
    });
});


function createTarStream(fileAndContents) {
    var pack = tarstream.pack();

    Object.keys(fileAndContents).forEach(function (name) {
        pack.entry({ name: name }, fileAndContents[name]);
    });

    pack.finalize();

    return pack;
}

test(TP + 'tag and push', function (tt) {
    var tagName = 'joyentunsupported/test_tag_and_push';

    tt.test(TP + 'tag busybox as ' + tagName, function (t) {
        cli.docker('tag busybox ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Tagging busybox as ' + tagName);
            t.end();
        }
    });

    tt.test(TP + 'push ' + tagName, function (t) {
        cli.docker('push ' + tagName, {}, onComplete);
        function onComplete(err, stdout, stderr) {
            t.ifErr(err, 'Pushing ' + tagName);
            // We expect an error in stdout.
            var expectedErr = 'Unauthorized error from registry docker.io '
                + 'trying to push ' + tagName;
            var authFailure = stdout.indexOf(expectedErr) >= 0;
            if (!authFailure) {
                t.fail('Expected authorization failure, got ' + stdout);
            }
            t.end();
        }
    });

    // Cleanup images we pulled down.

    tt.test('delete tagged image', function (t) {
        DOCKER_ALICE.del('/images/' + encodeURIComponent(tagName),
            function (err) {
                t.ifErr(err, 'deleting ' + tagName);
                t.end();
            }
        );
    });
});


/*
test(TP + 'build and push', function (tt) {
    tt.test('docker build image', function (t) {
        var dockerImageId = null;
        var tarStream;

        vasync.waterfall([

            function createTar(next) {
                var fileAndContents = {
                    'Dockerfile': 'FROM scratch\n'
                                + 'LABEL sdcdockertest_push=yes\n'
                                + 'ADD dummy.txt\n',
                    'dummy.txt': 'Some contents\n'
                };
                tarStream = createTarStream(fileAndContents);
                next();
            },

            function buildContainer(next) {
                h.buildDockerContainer({
                    dockerClient: DOCKER_ALICE_HTTP,
                    test: t,
                    tarball: tarStream
                }, onbuild);

                function onbuild(err, result) {
                    t.ifError(err, 'built successfully');
                    next(err, result);
                }
            },

            function checkResults(result, next) {
                if (!result || !result.body) {
                    next(new Error('build generated no output!?'));
                    return;
                }

                var output = result.body;
                var hasSuccess = output.indexOf('Successfully built') >= 0;
                t.ok(hasSuccess, 'output should contain: Successfully built');

                if (hasSuccess) {
                    var reg = new RegExp('Successfully built (\\w+)');
                    dockerImageId = output.match(reg)[1];
                } else {
                    t.fail('Output: ' + output);
                }

                next();
            },

            function removeBuiltImage(next) {
                t.ok(dockerImageId, 'got the built docker image id');
                DOCKER_ALICE.del('/images/' + dockerImageId, next);
            }

        ], function allDone(err) {
            t.ifErr(err);
            t.end();
        });

    });
});
*/
