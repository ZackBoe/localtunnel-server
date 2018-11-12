import log from 'book';
import Koa from 'koa';
import tldjs from 'tldjs';
import Debug from 'debug';
import http from 'http';
import { hri } from 'human-readable-ids';
import Router from 'koa-router';

import ClientManager from './lib/ClientManager';

const debug = Debug('localtunnel:server');

export default function(opt) {
    
    opt = opt || {};

    const validHosts = (opt.domain) ? [opt.domain] : undefined;
    const myTldjs = tldjs.fromUserSettings({ validHosts });
    const landingPage = opt.landing || 'https://localtunnel.github.io/www/';

    function GetClientIdFromHostname(hostname) {
        return myTldjs.getSubdomain(hostname);
    }

    const manager = new ClientManager(opt);

    const schema = opt.secure ? 'https' : 'http';

    const app = new Koa();
    const router = new Router();
    
    app.use(async (ctx, next) => {
        try {
            await next();
        } catch (err) {
            ctx.status = err.status || 500;
            ctx.body = err.message;            
            ctx.app.emit('error', err, ctx);
        }
    });
    
    if (opt.require_token) {
        app.use((ctx, next) => {
            const token = ctx.request.query.token;
            if (!token || opt.tokens.indexOf(token) === -1) {
                const err = new Error(`Missing or unknown token.`);
                err.status = 511;
                err.code = 'TOKEN_ERROR';
                throw err;
            } else {
                return next();
            }
        });
    }

    router.get('/tunnels/status', async (ctx, next) => {
        const stats = manager.stats;
        ctx.body = {
            tunnels: stats.tunnels,
            mem: process.memoryUsage(),
        };
    });

    router.get('/tunnels/:id/status', async (ctx, next) => {
        const clientId = ctx.params.id;
        const client = manager.getClient(clientId);
        if (!client) {
            ctx.throw(404);
            return;
        }

        const stats = client.stats();
        ctx.body = {
            connected_sockets: stats.connectedSockets,
        };
    });

    // Request that does not specify a client name
    router.get('/tunnels', async (ctx, next) => {
	const reqId = hri.random();
	debug('making new api client with id %s', reqId);
	const info = await manager.newClient(reqId);

	const url = schema + '://' + info.id + '.' + ctx.request.host;
	info.url = url;
	ctx.body = info;
	return;
    });

    // Request for a specific client name
    router.get('/tunnels/:id', async (ctx, next) => {
        const parts = ctx.params.id.split('/');

        // any request with several layers of paths is not allowed
        // rejects /foo/bar
        // allow /foo
        if (parts.length !== 1) {
            await next();
            return;
        }

        const reqId = parts[0];

        // limit requested hostnames to 63 characters
        if (! /^(?:[a-z0-9][a-z0-9\-]{4,63}[a-z0-9]|[a-z0-9]{4,63})$/.test(reqId)) {
            const msg = 'Invalid subdomain. Subdomains must be lowercase and between 4 and 63 alphanumeric characters.';
            ctx.status = 403;
            ctx.body = {
                message: msg,
            };
            return;
        }

        debug('making new client with id %s', reqId);
        const info = await manager.newClient(reqId);

        const url = schema + '://' + info.id + '.' + ctx.request.host;
        info.url = url;
        ctx.body = info;
        return;
    });

    app.use(router.routes());
    app.use(router.allowedMethods());

    // root endpoint
    app.use(async (ctx, next) => {
        const path = ctx.request.path;

        // skip anything not on the root path
        if (path !== '/') {
            await next();
            return;
        }

        // no new client request, send to landing page
        ctx.redirect(landingPage);
    });

    const server = http.createServer();

    const appCallback = app.callback();

    server.on('request', (req, res) => {
        // without a hostname, we won't know who the request is for
        const hostname = req.headers.host;
        if (!hostname) {
            res.statusCode = 400;
            res.end('Host header is required');
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            appCallback(req, res);
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            res.statusCode = 404;
            res.end('404');
            return;
        }

        client.handleRequest(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
        const hostname = req.headers.host;
        if (!hostname) {
            sock.destroy();
            return;
        }

        const clientId = GetClientIdFromHostname(hostname);
        if (!clientId) {
            sock.destroy();
            return;
        }

        const client = manager.getClient(clientId);
        if (!client) {
            socket.destroy();
            return;
        }

        client.handleUpgrade(req, socket);
    });

    return server;
};
