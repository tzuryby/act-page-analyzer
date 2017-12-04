import _ from 'lodash';

import evalWindowProperties, { getNativeWindowProperties } from '../parse/window-properties';
import parseResponse from '../parse/xhr-requests';

const IGNORED_EXTENSIONS = ['.css', '.png', '.jpg', '.svg'];

const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/62.0.3202.75 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_13_1) AppleWebKit/604.3.5 (KHTML, like Gecko) Version/11.0.1 Safari/604.3.5',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.13; rv:56.0) Gecko/20100101 Firefox/56.0',
    'Mozilla/5.0 (Windows NT 6.3; Trident/7.0; rv:11.0) like Gecko',
];

export default class PageScrapper {
    constructor(browser) {
        this.browser = browser;
        this.requests = {};
        this.handlers = {};
        this.mainRequestId = null;

        this.on = this.on.bind(this);
        this.call = this.call.bind(this);
        this.start = this.start.bind(this);
        this.getOrCreateRequestRecord = this.getOrCreateRequestRecord.bind(this);
        this.onRequest = this.onRequest.bind(this);
        this.onResponse = this.onResponse.bind(this);
        this.onPageError = this.onPageError.bind(this);
    }

    on(action, handler) {
        this.handlers[action] = handler;
    }

    call(action, data) {
        if (this.handlers[action]) {
            this.handlers[action](data);
        }
    }

    getOrCreateRequestRecord(requestId) {
        let rec = this.requests[requestId];
        if (!rec) {
            rec = {
                url: null,
                method: null,
                responseStatus: null,
                responseHeaders: null,
            };
            this.requests[requestId] = rec;
        }
        return rec;
    }

    onRequest(request) {
        const ignore = IGNORED_EXTENSIONS.reduce((ignored, extension) => {
            if (ignored) return ignored;
            return request.url.endsWith(extension);
        }, false);

        if (ignore) {
            request.abort();
            return;
        }
        request.continue();

        if (!this.mainRequestId) {
            this.mainRequestId = request._requestId;
        }

        const rec = this.getOrCreateRequestRecord(request._requestId);
        rec.url = request.url;
        rec.method = request.method;
        this.call('request', request);
    }
    async onResponse(response) {
        const request = response.request();
        const rec = this.requests[request._requestId];
        if (!rec) return;

        const data = await parseResponse(response);
        if (!data.ignore) {
            rec.responseStatus = data.status;
            rec.responseHeaders = data.headers;
            rec.responseBody = data.body;
            this.requests[request._requestId] = rec;
        } else {
            this.requests[request._requestId] = undefined;
        }
        if (this.mainRequestId === request._requestId) {
            this.call('initial-response', rec);
        } else {
            this.call('response', rec);
        }
    }

    async onPageError(err) {
        this.call('page-error', err);
        this.closePage();
    }

    async closePage() {
        try {
            await this.page.close();
        } catch (error) {
            this.call('error', {
                message: 'Error closing page',
                error,
            });
        }
    }

    async start(url) {
        this.requests = {};
        this.mainRequestId = null;
        this.page = null;

        try {
            this.page = await this.browser.newPage();
            const agentID = Math.floor(Math.random() * 4);
            await this.page.setUserAgent(USER_AGENTS[agentID]);
            this.page.setRequestInterceptionEnabled(true);

            this.page.on('error', this.onPageError);

            const nativeWindowsProperties = await getNativeWindowProperties(this.page);

            this.page.on('request', this.onRequest);
            this.page.on('response', this.onResponse);

            this.call('started', { url, timestamp: new Date() });

            let endIfTimedOut;

            try {
                await this.page.goto(url, { timeout: 5000, waitUntil: 'networkidle', networkIdleTimeout: 1000 });
            } catch (error) {
                console.error(error);
            }

            this.call('loaded', { url, timestamp: new Date() });

            const rec = this.requests[this.mainRequestId];

            if (!rec) {
                this.closePage();
                return;
            }

            this.call(
                'requests',
                Object.keys(this.requests)
                    .filter(requestId => {
                        if (requestId === this.mainRequestId) return false;
                        if (!this.requests[requestId]) return false;
                        if (!this.requests[requestId].responseBody) return false;
                        return true;
                    })
                    .map(requestId => this.requests[requestId]),
            );

            const data = await this.page.evaluate(() => ({
                html: document.documentElement.innerHTML, // eslint-disable-line
                allWindowProperties: Object.keys(window), // eslint-disable-line
            }));

            this.call('html', data.html);

            // Extract list of non-native window properties
            let windowProperties = _.filter(data.allWindowProperties, (propName) => !nativeWindowsProperties[propName]);
            windowProperties = await this.page.evaluate(evalWindowProperties, windowProperties);
            if (endIfTimedOut) clearTimeout(endIfTimedOut);
            this.closePage();
            this.call('window-properties', windowProperties);
            this.call('done', new Date());
        } catch (e) {
            this.call('error', `Loading of web page failed (${url}): ${e}`);
            this.closePage();
        }
    }
}
