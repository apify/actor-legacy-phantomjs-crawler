const Url = require('url');
const utils = require('apify-shared/utilities');

const PROXY_PROTOCOL_REGEX = /^(http|socks5):$/i;

/**
 * Parses a proxy URL and returns an array of PhantomJS command-line args instructing to use that proxy.
 * Returns null if URL is invalid.
 * @param proxyUrl
 */
const proxyUrlToPhantomArgs = function (proxyUrl) {
    if (typeof (proxyUrl) !== 'string') return null;
    const parsed = Url.parse(proxyUrl);
    if (!parsed || !parsed.hostname || !PROXY_PROTOCOL_REGEX.test(parsed.protocol) || !parsed.port) return null;
    const phantomjsArg = [
        `--proxy=${parsed.hostname.toLowerCase()}:${parsed.port}`,
        `--proxy-type=${parsed.protocol.substr(0, parsed.protocol.length - 1).toLowerCase()}`];
    if (parsed.auth) phantomjsArg.push(`--proxy-auth=${parsed.auth}`);
    return phantomjsArg;
};


/**
 * Parses a proxy URL and returns it back in a canonical format. Returns null if proxy cannot be parsed.
 * @param proxyUrl
 * @param replaceAuthWith A string that should replace authentication part of the URL, or false-ish value.
 */
const canonicalizeProxyUrl = function (proxyUrl, replaceAuthWith) {
    if (typeof (proxyUrl) !== 'string') return null;
    const parsed = Url.parse(proxyUrl);
    if (!parsed || !parsed.host || !PROXY_PROTOCOL_REGEX.test(parsed.protocol) || !parsed.port) return null;
    let { auth } = parsed;
    if (auth && typeof (replaceAuthWith) === 'string' && replaceAuthWith) auth = replaceAuthWith;
    return `${parsed.protocol.toLowerCase()}//${auth ? `${auth}@` : ''}${parsed.host.toLowerCase()}`;
};

const filterProxyUrls = (proxyUrls) => {
    const result = [];
    proxyUrls.forEach((proxyUrl) => {
        if (proxyUrlToPhantomArgs(proxyUrl)) {
            result.push(proxyUrl);
        }
    });
    return result;
};

/**
 *
 * @param proxyUrls
 * @return {*}
 */
const parseProxyUrls = (proxyUrls) => {
    return proxyUrls
    .map((proxyUrl) => {
        if (!proxyUrl) return;

        const phantomjsArg = proxyUrlToPhantomArgs(proxyUrl);

        if (!phantomjsArg) return;

        return {
            url: proxyUrl,
            phantomjsArg,
        };
    })
    .filter((proxyObj) => proxyObj);
};


module.exports = Object.assign({}, utils, {
    proxyUrlToPhantomArgs,
    canonicalizeProxyUrl,
    parseProxyUrls,
    filterProxyUrls,
});

