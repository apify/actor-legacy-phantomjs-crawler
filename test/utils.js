var assert    = require('chai').assert;
var _         = require('underscore');
var utils     = require('../src/utils');


describe('utils', function() {

    describe('#proxyUrlToPhantomArgs()', function() {

        it('handles correct URLs well', function () {
            assert.deepEqual(
                utils.proxyUrlToPhantomArgs("hTTp://uSEr:paSSword@1.2.3.4:65535"),
                ["--proxy=1.2.3.4:65535", "--proxy-type=http", "--proxy-auth=uSEr:paSSword"]);

            assert.deepEqual(
                utils.proxyUrlToPhantomArgs("  socks5://uSEr@255.255.255.255:8080"),
                ["--proxy=255.255.255.255:8080", "--proxy-type=socks5", "--proxy-auth=uSEr"]);

            assert.deepEqual(
                utils.proxyUrlToPhantomArgs("SOCKS5://1.2.3.4:999  "),
                ["--proxy=1.2.3.4:999", "--proxy-type=socks5"]);

            assert.deepEqual(
                utils.proxyUrlToPhantomArgs("http://EXAMPLE.com:0"),
                ["--proxy=example.com:0", "--proxy-type=http"]);
        });

        it('handles incorrect URLs well', function () {
            assert.deepEqual(utils.proxyUrlToPhantomArgs(""), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs(null), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs(123456), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs(undefined), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs({}), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs([]), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("     "), null);

            assert.deepEqual(utils.proxyUrlToPhantomArgs("://user:password@1.2.3.4:65535"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("http://user:password@1.2.3.4:"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("http://user:password@host.com"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("http://user:password"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("://user:password@1.2.3.4:65535"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("://user:password@1.2.3.4:65535"), null);

            assert.deepEqual(utils.proxyUrlToPhantomArgs("something://user:password@1.2.3.4:1111"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("none://user:password@1.2.3.4:1111"), null);
            assert.deepEqual(utils.proxyUrlToPhantomArgs("blabla://user:password@1.2.3.4:1111"), null);
        });

    });

    describe('#canonicalizeProxyUrl()', function() {

        it('handles correct URLs well', function() {
            assert.deepEqual( utils.canonicalizeProxyUrl("hTTp://uSEr:paSSword@1.2.3.4:65535"), "http://uSEr:paSSword@1.2.3.4:65535" );
            assert.deepEqual( utils.canonicalizeProxyUrl("socks5://uSEr@255.255.255.255:8080"), "socks5://uSEr@255.255.255.255:8080" );
            assert.deepEqual( utils.canonicalizeProxyUrl("SOCKS5://1.2.3.4:999   "), "socks5://1.2.3.4:999" );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://EXAMPLE.com:0"), "http://example.com:0" );
            assert.deepEqual( utils.canonicalizeProxyUrl("   http://www.EXAMPLE.com:10"), "http://www.example.com:10" );

            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@1.2.3.4:1111", {}), "http://user:password@1.2.3.4:1111" );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@EXAMPLE.com:55555", ""), "http://user:password@example.com:55555" );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@1.2.3.4:1111", 5), "http://user:password@1.2.3.4:1111" );

            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@1.2.3.4:1111", "TEST"), "http://TEST@1.2.3.4:1111" );
            assert.deepEqual( utils.canonicalizeProxyUrl("socks5://user@example.com:22222", "TEST"), "socks5://TEST@example.com:22222" );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user@example.com:22222", "TesT"), "http://TesT@example.com:22222" );
        });

        it('handles incorrect URLs well', function() {
            assert.deepEqual( utils.canonicalizeProxyUrl(""), null );
            assert.deepEqual( utils.canonicalizeProxyUrl(null), null );
            assert.deepEqual( utils.canonicalizeProxyUrl(123456), null );
            assert.deepEqual( utils.canonicalizeProxyUrl(undefined), null );
            assert.deepEqual( utils.canonicalizeProxyUrl({}), null );
            assert.deepEqual( utils.canonicalizeProxyUrl([]), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("     "), null );

            assert.deepEqual( utils.canonicalizeProxyUrl("://user:password@1.2.3.4:65535", "test"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@1.2.3.4:", "test"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password@host.com"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("http://user:password"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("://user:password@1.2.3.4:65535"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("://user:password@1.2.3.4:65535"), null );

            assert.deepEqual( utils.canonicalizeProxyUrl("something://user:password@1.2.3.4:1111"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("none://user:password@1.2.3.4:1111"), null );
            assert.deepEqual( utils.canonicalizeProxyUrl("blabla://user:password@1.2.3.4:1111"), null );
        });
    });

    describe('#filterProxyUrls()', function() {
        it('works', function() {
            assert.deepEqual(utils.filterProxyUrls([
                'http://user:password@EXAMPLE.com:55555',
                '',
                null,
                'http://user:password',
                'bla',
                "hTTp://uSEr:paSSword@1.2.3.4:65535",
            ]), [
                'http://user:password@EXAMPLE.com:55555',
                "hTTp://uSEr:paSSword@1.2.3.4:65535"
            ]);
        });
    });

});
