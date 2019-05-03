# Legacy PhantomJS Crawler

This actor implements the legacy Apify Crawler product.
It uses [PhantomJS](http://phantomjs.org/) headless browser to recursively
crawl websites and extract data from them using a front-end JavaScript code.
Note that PhantomJS is no longer developed by the community
and it might be easily detected and blocked by target websites.
Therefore, for new projects, we recommend to use the
[`apify/web-scraper`](https://apify.com/apify/web-scraper) actor,
which provides similar functionality, but is based on the modern headless Chrome browser.

## Compatibility with legacy Apify Crawler

Apify Crawler used to be a core product of Apify, but in April 2019 it has been deprecated in favor of the more general
[Apify Actors](https://apify.com/actors) product.
This actor serves as a replacement of the legacy product and provides an equivalent interface and functionality,
in order to enable users to seamlessly migrate their crawlers.
Note that there are several differences between this actor and legacy Apify Crawler:

- The **Cookies persistence** setting of **Over all crawler runs**
  is only supported when running the actor as a [task](https://apify.com/docs/tasks).
  When you run the actor directly and use this setting,
  the actor will fail and print an error to log.
- In **Page function**, the `context` object passed to the function has a slightly different properties:
  - `stats` object contains only a subset of the original statistics. [See details](#context-stats)
  - `actExecutionId` and `actId` properties are not defined and were replaced by `actorRunId` and `actorTaskId`, respectively.
- The **Finish webhook URL** and **Finish webhook data** settings
  are no longer supported, please use the [webhooks](https://apify.com/docs/webhooks) for actors instead.
  If you pass these fields when calling the actor, you will receive an error.
- The actor supports legacy **proxy settings** fields `proxyType`, `proxyGroups` and `customProxies`,
  but their values are not checked. If these settings are invalid,
  the actor will start normally and might crawl the pages with invalid proxy settings,
  most likely producing invalid results.
  It is recommended to use the new **Proxy configuration** (`proxyConfiguration`)
  field instead, which is correctly validated before the actor is started.   
- The **Test URL** feature is not supported.
  
<!-- TODO:
For more details how to migrate your crawlers to this actor, please see our blog post.
-->

## Overview

This actor provides a web crawler for developers that enables scraping data from
any website using the primary programming language of the web: JavaScript.

In order to extract structured data from a website, you only need two things. First, tell the crawler which pages it
should visit (see <a href="#start-urls">Start URLs</a> and <a href="#pseudo-urls">Pseudo-URLs</a>) and second, define
a JavaScript code that will be executed on every web page visited in order to extract the data from it
(see <a href="#page-function">Page function</a>).
The crawler is a full-featured web browser which loads and interprets JavaScript and the code you provide is simply
executed in the context of the pages it visits. This means that writing your data-extraction code is very similar
to writing JavaScript code in front-end development, you can even use any client-side libraries such as
<a href="http://jquery.com" target="_blank" rel="noopener">jQuery</a> or
<a href="http://underscorejs.org" target="_blank" rel="noopener">Underscore.js</a>.

Imagine the crawler as a guy sitting in front of a web browser. Let's call him Bob. Bob opens a start URL and waits
for the page to load, executes your JavaScript code using a developer console, writes down the result and then
right-clicks all links on the web page to open them in new browser tabs.
After that, Bob closes the current tab, goes to the next tab and repeats the same action again.
Bob is pretty smart and skips pages that he has already visited.
When there are no more pages, he is done. And this is where the magic happens.
Bob would need about a month to click through a few hundred pages.
Apify can do it in a few seconds and makes fewer mistakes.

More formally, the crawler repeats the following steps:

<ol>
    <li>Add each of the <a href="#start-urls">Start URLs</a> into the crawling queue.</li>
    <li>Fetch the first URL from the queue and load it in the virtual browser.</li>
    <li>Execute <a href="#page-function">Page function</a> on the loaded page and save its results.</li>
    <li>Find all links from the page using <a href="#clickable-elements">Clickable elements</a> CSS selector.
        If a link matches any of the <a href="#pseudo-urls">Pseudo-URLs</a> and has not yet been enqueued, add it to the queue.</li>
    <li>If there are more items in the queue, go to step 2, otherwise finish.</li>
</ol>

This process is depicted in the following diagram.
Note that blue elements represent settings or operations that can be affected by crawler settings.
These settings are described in detail in the following sections.

<center>
    <a href="https://raw.githubusercontent.com/apifytech/actor-legacy-phantomjs-crawler/master/img/crawler-activity-diagram.001.png" target="_blank" rel="noopener"><img
        src="https://raw.githubusercontent.com/apifytech/actor-legacy-phantomjs-crawler/master/img/crawler-activity-diagram.001.png" alt="Web crawler activity diagram"
        class="img-responsive"/></a>
</center>

Note that each crawler configuration setting can also be set using the API, the corresponding property names and types are
described in the [Input schema](https://apify.com/apify/web-scraper?section=input-schema) section.

## Start URLs

The **Start URLs** (`startUrls`) field represent the list of URLs of the first pages that the crawler will open.
Optionally, each URL can be associated with a custom label that can be referenced from
your JavaScript code to determine which page is currently open
(see <a href="#request-object">Request object</a> for details).
Each URL must start with either a `http://` or `https://` protocol prefix!

Note that it is possible to instruct the crawler to load a URL using a HTTP POST request
simply by suffixing it with a `[POST]` marker, optionally followed by
POST data (e.g. `http://www.example.com[POST]<wbr>key1=value1&key2=value2`).
By default, POST requests are sent with
the `Content-Type: application/x-www-form-urlencoded` header.

Maximum label length is 100 characters and maximum URL length is 2000 characters.

## Pseudo-URLs

The **Pseudo-URLs** (`crawlPurls`) field specifies which pages will be visited by the crawler using
the so-called <i>pseudo-URLs</i> (PURL)
format. PURL is simply a URL with special directives enclosed in `[]` brackets.
Currently, the only supported directive is `[regexp]`, which defines
a JavaScript-style regular expression to match against the URL.

For example, a PURL `http://www.example.com/pages/[(\w|-)*]` will match all of the
following URLs:

- `http://www.example.com/pages/`
- `http://www.example.com/pages/my-awesome-page`
- `http://www.example.com/pages/something`

If either `[` or `]` is part of the normal query string,
it must be encoded as `[\x5B]` or `[\x5D]`, respectively. For example,
the following PURL:

```
http://www.example.com/search?do[\x5B]load[\x5D]=1
```

will match the URL:

```
http://www.example.com/search?do[load]=1
```

Optionally, each PURL can be associated with a custom label that can be referenced from
your JavaScript code to determine which page is currently open
(see <a href="#request-object">Request object</a> for details).

Note that you don't need to use this setting at all,
because you can completely control which pages the crawler will access, either using the
<a href="#intercept-request-function">Intercept request function</a>
or by calling `context.enqueuePage()` inside the <a href="#page-function">Page function</a>.

Maximum label length is 100 characters
and maximum PURL length is 1000 characters.

## Clickable elements

The **Clickable elements** (`clickableElementsSelector`) field contains a CSS selector used to find links to other web pages.
On each page, the crawler clicks all DOM elements matching this selector
and then monitors whether the page generates a navigation request.
If a navigation request is detected, the crawler checks whether it matches
<a href="#pseudo-urls">Pseudo-URLs</a>,
invokes <a href="#intercept-request-function">Intercept request function</a>,
cancels the request and then continues clicking the next matching elements.
By default, new crawlers are created with a safe CSS selector:

```
a:not([rel=nofollow])
```

In order to reach more pages, you might want to use a wider CSS selector, such as:

```
a:not([rel=nofollow]), input, button, [onclick]:not([rel=nofollow])
```


Be careful - clicking certain DOM elements can cause
<b>unexpected and potentially harmful side effects</b>.
For example, by clicking buttons you might submit forms, flag comments, etc.
In principle, the safest option is to narrow the CSS selector to as few elements as possible,
which also makes the crawler run much faster.

Leave this field empty if you do not want the crawler to click any elements and only open
<a href="#start-urls">Start URLs</a>
or pages enqueued using <code>enqueuePage()</code>.


## Page function

The **Page function** (`pageFunction`) field contains
a user-provided JavaScript function that is executed in the context of every web page loaded by
the crawler.
Page function is typically used to extract some data from the page, but it can also be used
to perform some non-trivial
operation on the page, e.g. handle AJAX-based pagination.

<b>IMPORTANT:</b> This actor is using <a href="http://phantomjs.org/" target="_blank" rel="noopener">PhantomJS</a>
headless web browser, which only supports JavaScript ES5.1 standard
(read more in a <a href="https://ariya.io/2014/08/phantomjs-2-and-javascript-goodies" target="_blank" rel="noopener">blog post about PhantomJS 2.0</a>).

The basic page function with no effect has the following signature:

```javascript
function pageFunction(context) {
    return null;
}
```

The function can return an arbitrary JavaScript object (including array, string, number, etc.) that can be stringified to JSON;
this value will be saved in the crawling results as the <code>pageFunctionResult</code>
field of the <a href="#request-object">Request object</a> corresponding to the web page
on which the <code>pageFunction</code> was executed.
The crawling results are stored in the default [dataset](https://apify.com/docs/storage#dataset)
associated with the actor run, from where they can be downloaded
in a computer-friendly form (JSON, JSONL, XML or RSS format),
as well as in a human-friendly tabular form (HTML or CSV format).
If the <code>pageFunction</code>'s return value is an array,
its elements can be displayed as separate rows in such a table,
to make the results more readable.

The function accepts a single argument called <code>context</code>,
which is an object with the following properties and functions:

<table class="table table-bordered">
    <thead>
    <tr>
        <th>Name</th>
        <th>Description</th>
    </tr>
    </thead>
    <tbody>
    <tr>
        <td id="context-request"><code>request</code></td>
        <td>An object holding all the available information about the currently loaded web page.
            See <a href="#request-object">Request object</a> for details.
        </td>
    </tr>
    <tr>
        <td id="context-jQuery"><code>jQuery</code></td>
        <td>A jQuery object, only available if the
            <strong>Inject jQuery</strong>
            setting is
            enabled.
        </td>
    </tr>
    <tr>
        <td id="context-underscoreJs"><code>underscoreJs</code></td>
        <td>The Underscore.js' <code>_</code> object, only available if the
            <strong>Inject Underscore.js</strong>
            setting is enabled.
        </td>
    </tr>
    <tr>
        <td id="context-skipLinks"><code>skipLinks()</code></td>
        <td>If called, the crawler will not follow any links from the current page and will
            continue with the next page from the queue.
            This is useful to speed up the crawl by avoiding unnecessary paths.
        </td>
    </tr>
    <tr>
        <td id="context-skipOutput"><code>skipOutput()</code></td>
        <td>If called, no information about the current page will be saved to the results,
            including the page function result itself.
            This is useful to reduce the size of the results by skipping unimportant pages.
            Note that if the page function throws an exception, the <code>skipOutput()</code>
            call is ignored and the page is outputted anyway, so that the user has a chance
            to determine whether there was an error
            (see <a href="#request-object">Request object</a>'s <code>errorInfo</code>
            field).
        </td>
    </tr>
    <tr>
        <td id="context-willFinishLater"><code>willFinishLater()</code></td>
        <td>Tells the crawler that the page function will continue performing some background
            operation even after it returns. This is useful
            when you want to fetch results from an asynchronous operation,
            e.g. an XHR request or a click on some DOM element.
            If you use the <code>willFinishLater()</code> function, make sure you also invoke <code>finish()</code>
            or the crawler will wait infinitely for the result and eventually timeout
            after the period specified in
            <strong>Page function timeout</strong>.
            Note that the normal return value of the page function is ignored.
        </td>
    </tr>
    <tr>
        <td id="context-finish"><code>finish(result)</code></td>
        <td>Tells the crawler that the page function finished its background operation.
            The <code>result</code> parameter receives the result of the page function - this is
            a replacement
            for the normal return value of the page function that was ignored (see <code>willFinishLater()</code> above).
        </td>
    </tr>
    <tr>
        <td id="context-saveSnapshot"><code>saveSnapshot() </code></td>
        <td>Captures a screenshot of the web page and saves its DOM to an HTML file,
            which are both then displayed in the user's crawling console.
            This is especially useful for debugging your page function.
        </td>
    </tr>
    <tr>
        <td id="context-enqueuePage"><code>enqueuePage(request)</code></td>
        <td>
            <p>
            Adds a new page request to the crawling queue, regardless of whether it matches
            any of the <a href="#pseudo-urls">Pseudo-URLs</a>.
            The <code>request</code> argument is an instance of the <a href="#request-object">Request object</a>,
            but only the following properties are taken into account:
            <code>url</code>, <code>uniqueKey</code>, <code>label</code>,
            <code>method</code>, <code>postData</code>, <code>contentType</code>,
            <code>queuePosition</code> and <code>interceptRequestData</code>; all other properties
            will be ignored. The <code>url</code> property is mandatory.
            </p>
            <p>
            Note that the manually enqueued page is subject to the same processing
            as any other page found by the crawler. For example,
            the <a href="#intercept-request-function">Intercept request function</a> function
            will be called for the new request, and the page will be checked to see whether it has
            already been visited by the crawler and skipped if so.
            </p>
            For backwards compatibility, the function also supports the following signature:
            <code>enqueuePage(url, method, postData, contentType)</code>.
        </td>
    </tr>
    <tr>
        <td id="context-saveCookies"><code>saveCookies([cookies]) </code></td>
        <td>Saves current cookies of the current PhantomJS browser to the actor task's
        <a href="#cookies">Initial cookies</a> setting.
        All subsequently started PhantomJS processes will use these cookies.
        For example, this is useful to store a login.
        Optionally, you can pass an array of cookies to set to the browser before saving (in
        <a href="http://phantomjs.org/api/phantom/property/cookies.html" target="_blank" rel="noopener">PhantomJS format</a>).
        Note that by passing an empty array you can unset all cookies.
        </td>
    </tr>
    <tr>
        <td id="context-customData"><code>customData</code></td>
        <td>Custom user data from crawler settings provided via <code>customData</code> input field.</td>
    </tr>
    <tr>
        <td id="context-stats"><code>stats</code></td>
        <td>An object containing a snapshot of statistics from the current crawl.
            It contains the following fields: `pagesCrawled`, `pagesOutputted` and `pagesInQueue`.
            Note that the statistics are collected <b>before</b>
            the current page has been crawled.
        </td>
    </tr>
    <tr>
        <td id="context-actorRunId"><code>actorRunId</code></td>
        <td>String containing ID of this actor run. It might be used to control
            the actor using the <a href="http://apify.com/docs/api/v2">API</a>,
            e.g. to stop it or fetch its results.
        </td>
    </tr>
    <tr>
        <td id="context-actorRunId"><code>actorTaskId</code></td>
        <td>String containing ID of the actor task, or <code>null</code> if actor is run directly.
            The ID might be used to control
            the task using the <a href="http://apify.com/docs/api/v2">API</a>.
        </td>
    </tr>
    </tbody>
</table>

Note that any changes made to the <code>context</code> parameter will be ignored.
When implementing the page function, it is the user's responsibility not to break normal
page's
scripts which might affect the operation of the crawler.

### Waiting for dynamic content

Some web pages do not load all their content immediately but only fetch it in the background
using AJAX,
while <code>pageFunction</code> might be executed before the content has actually been
loaded.
You can wait for dynamic content to load using the following code:

```javascript
function pageFunction(context) {
    var $ = context.jQuery;
    var startedAt = Date.now();

    var extractData = function() {
        // timeout after 10 seconds
        if( Date.now() - startedAt > 10000 ) {
            context.finish("Timed out before #my_element was loaded");
            return;
        }

        // if my element still hasn't been loaded, wait a little more
        if( $('#my_element').length === 0 ) {
            setTimeout(extractData, 500);
            return;
        }

        // refresh page screenshot and HTML for debugging
        context.saveSnapshot();

        // save a result
        context.finish({
            value: $('#my_element').text()
        });
    };

    // tell the crawler that pageFunction will finish asynchronously
    context.willFinishLater();

    extractData();
}
```

## Intercept request function

The **Intercept request function** (`interceptRequest`) field contains
a user-provided JavaScript function that is called whenever
a new URL is about to be added to the crawling queue,
which happens at the following times:

- At the start of crawling for all <a href="#start-urls">Start URLs.</a>
- When the crawler looks for links to new pages by clicking elements
  matching the <a href="#clickable-elements">Clickable elements</a>
  CSS selector and detects a page navigation request, i.e. a link (GET)
  or a form submission (POST) that would normally cause the browser to navigate to a new web page.
- Whenever a loaded page tries to navigate to another page, e.g. by setting <code>window.location</code> in JavaScript.
- When user code invokes <code>enqueuePage()</code> inside of <a href="#page-function">Page function</a>.

The intercept request function allows you to affect on a low level
how new pages are enqueued by the crawler.
For example, it can be used to ensure that the request is added to the crawling queue even
if it doesn't match
any of the <a href="#pseudo-urls">Pseudo-URLs</a>,
or to change the way the crawler determines whether the page has already been visited or not.
Similarly to the <a href="#page-function">Page function</a>,
this function is executed in the context of the originating web page (or in the context
of <code>about:blank</code> page for <a href="#start-urls">Start URLs</a>).

<b>IMPORTANT:</b> This actor is using <a href="http://phantomjs.org/" target="_blank" rel="noopener">PhantomJS</a>
headless web browser, which only supports the JavaScript ES5.1 standard
(read more in <a href="https://ariya.io/2014/08/phantomjs-2-and-javascript-goodies" target="_blank" rel="noopener">blog post about PhantomJS 2.0</a>).

The basic intercept request function with no effect has the following signature:

```javascript
function interceptRequest(context, newRequest) {
    return newRequest;
}
```

The <code>context</code> is an object with the following properties:

<table class="table table-bordered table-condensed">
    <tbody>
    <tr>
        <td><code>request</code></td>
        <td>An object holding all the available information about the currently loaded web page.
            See <a href="#request-object">Request object</a> for details.
        </td>
    </tr>
    <tr>
        <td><code>jQuery</code></td>
        <td>A <a href="http://api.jquery.com/jQuery/" target="_blank" rel="noopener">jQuery</a> object, only
            available if the
            <strong>Inject jQuery</strong>
            setting is
            enabled.
        </td>
    </tr>
    <tr>
        <td><code>underscoreJs</code></td>
        <td>An <a href="http://underscorejs.org/" target="_blank" rel="noopener">Underscore.js</a> object, only
            available if the
            <strong>Inject Underscore.js</strong>
            setting is enabled.
        </td>
    </tr>
    <tr>
        <td><code>clickedElement</code></td>
        <td>A reference to the DOM object whose clicking initiated the current navigation
            request.
            The value is <code>null</code> if the navigation request was initiated by other
            means,
            e.g. using some background JavaScript action.
        </td>
    </tr>
    </tbody>
</table>

Beware that in rare situations when the page redirects in its JavaScript before it was
completely loaded
by the crawler, the <code>jQuery</code> and <code>underscoreJs</code> objects will be undefined.
The <code>newRequest</code> parameter contains a <a href="#request-object">Request object</a>
corresponding to the new page.

The way the crawler handles the new page navigation request depends
on the return value of the <code>interceptRequest</code> function in the following way:

<ul>
    <li>If function returns the <code>newRequest</code> object unchanged,
        the default crawler behaviour will apply.
    </li>
    <li>If function returns the <code>newRequest</code> object altered, the crawler
        behavior will be modified, e.g. it will enqueue a page that would not normally be skipped.
        The following fields can be altered:
        <code>willLoad</code>, <code>url</code>, <code>method</code>, <code>postData</code>,
        <code>contentType</code>,
        <code>uniqueKey</code>, <code>label</code>, <code>interceptRequestData</code>
        and <code>queuePosition</code>
        (see <a href="#request-object">Request object</a> for details).
    </li>
    <li>If function returns <code>null</code>, the request will be dropped and a new page will not
        be enqueued.
    </li>
    <li>If function throws an exception, the default crawler behaviour will apply
        and the error will be logged to Request object's <code>errorInfo</code> field.
        Note that this is the only way a user can catch and debug such an exception.
    </li>
</ul>

<p>
    Note that any changes made to the <code>context</code> parameter will be ignored
    (unlike the <code>newRequest</code> parameter).
    When implementing the function, it is the user's responsibility not to break normal page
    scripts that might affect the operation of the crawler. You have been warned.
    Also note that the function does not resolve HTTP redirects: it only reports the originally
    requested URL, but does not open it to find out which URL it eventually redirects to.
</p>


## Proxy configuration

The **Proxy configuration** (`proxyConfiguration`) option enables you to set
proxies that will be used by the crawler in order to prevent its detection by target websites.
You can use both [Apify Proxy](https://apify.com/proxy)
as well as custom HTTP or SOCKS5 proxy servers.

The following table lists the available options of the proxy configuration setting:

<table class="table table-bordered table-condensed">
    <tbody>
    <tr>
        <th><b>None</b></td>
        <td>
            Crawler will not use any proxies.
            All web pages will be loaded directly from IP addresses of Apify servers running on Amazon Web Services.
        </td>
    </tr>
    <tr>
        <th><b>Apify&nbsp;Proxy&nbsp;(automatic)</b></td>
        <td>
            The crawler will load all web pages using <a href="https://apify.com/proxy">Apify Proxy</a>
            in the automatic mode. In this mode, the proxy uses all proxy groups
            that are available to the user, and for each new web page it automatically selects the proxy
            that hasn't been used in the longest time for the specific hostname,
            in order to reduce the chance of detection by the website.
            You can view the list of available proxy groups
            on the <a href="https://my.apify.com/proxy" target="_blank" rel="noopener">Proxy</a> page in the app.
        </td>
    </tr>
    <tr>
        <th><b>Apify&nbsp;Proxy&nbsp;(selected&nbsp;groups)</b></td>
        <td>
            The crawler will load all web pages using <a href="https://apify.com/proxy">Apify Proxy</a>
            with specific groups of target proxy servers.
        </td>
    </tr>
    <tr>
        <th><b>Custom&nbsp;proxies</b></td>
        <td>
            <p>
            The crawler will use a custom list of proxy servers.
            The proxies must be specified in the <code>scheme://user:password@host:port</code> format,
            multiple proxies should be separated by a space or new line.
            The URL scheme can be either <code>http</code> or <code>socks5</code>.
            User and password might be omitted, but the port must always be present.
            </p>
            <p>
                Example:
            </p>
            <pre><code class="language-none">http://bob:password@proxy1.example.com:8000
http://bob:password@proxy2.example.com:8000</code></pre>
        </td>
    </tr>
    </tbody>
</table>

Note that the proxy server used to fetch a specific page
is stored to the <code>proxy</code> field of the <a href="#requestObject">Request object</a>.
Note that for security reasons, the usernames and passwords are redacted from the proxy URL.

The proxy configuration can be set programmatically when calling the actor using the API
by setting the `proxyConfiguration` field.
It accepts a JSON object with the following structure:

```javascript
{
    // Indicates whether to use Apify Proxy or not.
    "useApifyProxy": Boolean,

    // Array of Apify Proxy groups, only used if "useApifyProxy" is true.
    // If missing or null, Apify Proxy will use the automatic mode.
    "apifyProxyGroups": String[],

    // Array of custom proxy URLs, in "scheme://user:password@host:port" format.
    // If missing or null, custom proxies are not used.
    "proxyUrls": String[],
}
```

## Cookies

The **Initial cookies** (`cookies`) option enables you to specify
a JSON array with cookies that will be used by the crawler on start. 
You can export the cookies from your own web browser,
for example using the <a href="http://www.editthiscookie.com/" target="_blank" rel="noopener">EditThisCookie</a> plugin.
This setting is typically used to start crawling when logged in to certain websites.
The array might be null or empty, in which case the crawler will start with no cookies.

Note that if the <a href="#cookies-persistence-option">Cookie persistence</a>
setting is <b>Over all crawler runs</b> and the actor is started from within a
<a href="https://apify.com/docs/tasks">task</a>
the cookies array on the task will be overwritten
with fresh cookies from the crawler whenever it successfully finishes.

<b>SECURITY NOTE:</b> You should never share cookies or an exported crawler configuration containing cookies
with untrusted parties, because they might use it to authenticate themselves to various websites with your credentials.

Example of **Initial cookies** setting:

```json
[
  {
    "domain": ".example.com",
    "expires": "Thu, 01 Jun 2017 16:14:38 GMT",
    "expiry": 1496333678,
    "httponly": true,
    "name": "NAME",
    "path": "/",
    "secure": false,
    "value": "Some value"
  },
  {
    "domain": ".example.com",
    "expires": "Thu, 01 Jun 2017 16:14:37 GMT",
    "expiry": 1496333677,
    "httponly": true,
    "name": "OTHER_NAME",
    "path": "/",
    "secure": false,
    "value": "Some other value"
  }
]
```

The **Cookies persistence** (`cookiesPersistence`) option
indicates how the crawler saves and reuses cookies.
When you start the crawler, the first PhantomJS process will
use the cookies defined by the <a href="#cookies">cookies</a> setting.
Subsequent PhantomJS processes will use cookies as follows:
</p>
<table class="table table-bordered">
    <tbody>
        <tr>
            <td style="width: 30%"><b>Per single crawling process only</b><br><code>"PER_PROCESS"</code></td>
            <td style="width: 70%">
                Cookies are only maintained separately by each PhantomJS crawling process
                for the lifetime of that process. The cookies are not shared between crawling processes.
                This means that whenever the crawler rotates its IP address, it will start
                again with cookies defined by the <a href="#cookies">cookies</a> setting.
                Use this setting for maximum privacy and to avoid detection of the crawler.
                This is the <b>default</b> option.
            </td>
        </tr>
        <tr>
            <td><b>Per full crawler run</b><br><code>"PER_CRAWLER_RUN"</code></td>
            <td>
                Indicates that cookies collected at the start of the crawl by the first PhantomJS process
                are reused by other PhantomJS processes, even when switching to a new IP address.
                This might be necessary to maintain a login performed at the beginning of your crawl,
                but it might help the server to detect the crawler.
                Note that cookies are only collected at the beginning of the crawl by the initial
                PhantomJS process. Cookies set by subsequent PhantomJS processes are only valid for the duration of that
                process and are not reused by other processes. This is necessary to enable crawl parallelization.
            </td>
        </tr>
        <tr>
            <td><b>Over all crawler runs<br><code>"OVER_CRAWLER_RUNS"</code></b></td>
            <td>
                This setting is similar to <b>Per full crawler run</b>,
                the only difference is that if the actor finishes with <code>SUCCEEDED</code> status,
                its current cookies are automatically saved
                to the <a href="#cookies">cookies</a> setting of the actor task
                used to start the actor,
                so that new crawler run starts where the previous run left off.
                This is useful to keep login cookies fresh and avoid their expiration.
            </td>
        </tr>
    </tbody>
</table>


## Crawling results

The crawling results are stored in the default dataset associated with the actor run,
from where you can export them to formats such as JSON, XML, CSV or Excel.
For each web page visited, the crawler pushes a single
[Request object](#requestObject) with all the details about the page into the dataset.

To download the results, call the
[Get dataset items](https://apify.com/docs/api/v2#/reference/datasets/item-collection)
API endpoint:

```
https://api.apify.com/v2/datasets/[DATASET_ID]/items?format=json
```

where `[DATASET_ID]` is the ID of actor's run dataset,
which you can find the Run object returned when starting the actor.
The response looks as follows:

```json
[{
  "loadedUrl": "https://www.example.com/",
  "requestedAt": "2019-04-02T21:27:33.674Z",
  "type": "StartUrl",
  "label": "START",
  "pageFunctionResult": [
    {
      "product": "iPhone X",
      "price": 699
    },
    {
      "product": "Samsung Galaxy",
      "price": 499
    }
  ],
  ...
},
...
]
```

To download the data in simplified format known in the legacy Apify Crawler
product, add the `fields=url,pageFunctionResult,errorInfo`
and `unwind=pageFunctionResult` query parameters:

```
https://api.apify.com/v2/datasets/[DATASET_ID]/items?format=json&fields=url,pageFunctionResult,errorInfo&unwind=pageFunctionResult
```

The response will look like this:

```javascript
[{
  "url": "https://www.example.com/",
  "errorInfo": "",
  "product": "iPhone X",
  "price": 699
},
{
  "url": "https://www.example.com/",
  "errorInfo": "",
  "product": "Samsung Galaxy",
  "price": 499
}]
```

To get the results in other formats, set `format` query parameter to `xml`, `xlsx`, `csv`, `html`, etc.
For full details, see the [Get dataset items](https://apify.com/docs/api/v2#/reference/datasets/item-collection)
endpoint in API reference.


## Request object

This object contains all the available information about every single web page the crawler
encounters
(both visited and not visited). This object comes into play
in both <a href="#page-function">Page function</a>
and <a href="#intercept-request-function">Intercept request function</a>
and crawling results are actually just an array of these objects.

The Request object has the following schema:

```javascript
{
  // A string with a unique identifier of the Request object.
  // It is generated from the uniqueKey, therefore two pages from various crawls
  // with the same uniqueKey will also have the same ID.
  id: String,

  // The URL that was specified in the web page's navigation request,
  // possibly updated by the 'interceptRequest' function
  url: String,

  // The final URL reported by the browser after the page was opened
  // (will be different from 'url' if there was a redirect)
  loadedUrl: String,

  // Date and time of the original web page's navigation request
  requestedAt: Date,
  // Date and time when the page load was initiated in the web browser, or null if it wasn't
  loadingStartedAt: Date,
  // Date and time when the page was actually loaded, or null if it wasn't
  loadingFinishedAt: Date,

  // HTTP status and headers of the loaded page.
  // If there were any redirects, the status and headers correspond to the final response, not the intermediate responses.
  responseStatus: Number,
  responseHeaders: Object,

  // If the page could not be loaded for any reason (e.g. a timeout), this field contains a best guess of
  // the code of the error. The value is either one of the codes from QNetworkReply::NetworkError codes
  // or value 999 for an unknown error. This field is used internally to retry failed page loads.
  // Note that the field is only informative and might not be set for all types of errors,
  // always use errorInfo to determine whether the page was processed successfully.
  loadErrorCode: Number,

  // Date and time when the page function started and finished
  pageFunctionStartedAt: Date,
  pageFunctionFinishedAt: Date,

  // An arbitrary string that uniquely identifies the web page in the crawling queue.
  // It is used by the crawler to determine whether a page has already been visited.
  // If two or more pages have the same uniqueKey, then the crawler only visits the first one.
  //
  // By default, uniqueKey is generated from the 'url' property as follows:
  //  * hostname and protocol is converted to lower-case
  //  * trailing slash is removed
  //  * common tracking parameters starting with 'utm_' are removed
  //  * query parameters are sorted alphabetically
  //  * whitespaces around all components of the URL are trimmed
  //  * if the 'considerUrlFragment' setting is disabled, the URL fragment is removed completely
  //
  // If you prefer different generation of uniqueKey, you can override it in the 'interceptRequest'
  // or 'context.enqueuePage' functions.
  uniqueKey: String,

  // Describes the type of the request. It can be either one of the following values:
  // 'InitialAboutBlank', 'StartUrl', 'SingleUrl', 'ActorRequest', 'OnUrlChanged', 'UserEnqueued', 'FoundLink'
  // or in case the request originates from PhantomJS' onNavigationRequested() it can be one of the following values:
  // 'Undefined', 'LinkClicked', 'FormSubmitted', 'BackOrForward', 'Reload', 'FormResubmitted', 'Other'
  type: String,

  // Boolean value indicating whether the page was opened in a main frame or a child frame
  isMainFrame: Boolean,

  // HTTP POST payload
  postData: String,

  // Content-Type HTTP header of the POST request
  contentType: String,

  // Contains "GET" or "POST"
  method: String,

  // Indicates whether the page will be loaded by the crawler or not
  willLoad: Boolean,

  // Indicates the label specified in startUrls or crawlPurls config settings where URL/PURL corresponds
  // to this page request. If more URLs/PURLs are matching, this field contains the FIRST NON-EMPTY
  // label in order in which the labels appear in startUrls and crawlPurls arrays.
  // Note that labels are not mandatory, so the field might be null.
  label: String,

  // ID of the Request object from whose page this Request was first initiated, or null.
  referrerId: String,

  // Contains the Request object corresponding to 'referrerId'.
  // This value is only available in pageFunction and interceptRequest functions
  // and can be used to access properties and page function results of the page linking to the current page.
  // Note that the referrer Request object DOES NOT recursively define the 'referrer' property.
  referrer: Object,

  // How many links away from start URLs was this page found
  depth: Number,

  // If any error occurred while loading or processing the web page,
  // this field contains a non-empty string with a description of the error.
  // The field is used for all kinds of errors, such as page load errors, the page function or
  // intercept request function exceptions, timeouts, internal crawler errors etc.
  // If there is no error, the field is a false-ish value (empty string, null or undefined).
  errorInfo: String,

  // Results of the user-provided 'pageFunction'
  pageFunctionResult: Anything,

  // A field that might be used by 'interceptRequest' function to save custom data related to this page request
  interceptRequestData: Anything,

  // Total size of all resources downloaded during this request
  downloadedBytes: Number,

  // Indicates the position where the request will be placed in the crawling queue.
  // Can either be 'LAST' to put the request to the end of the queue (default behavior)
  // or 'FIRST' to put it before any other requests.
  queuePosition: String,

  // Custom proxy used by the crawler, or null if custom proxies were not used.
  // For security reasons, the username and password are redacted from the URL.
  proxy: String
}
```
