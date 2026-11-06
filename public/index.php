<?php
declare(strict_types=1);

require dirname(__DIR__) . '/app/bootstrap.php';

use WebManager\Http\ApiV1;
use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Http\Router;
use WebManager\Support\ApiToken;
use WebManager\Support\Audit;
use WebManager\Support\View;

$req = Request::fromGlobals();
Response::securityHeaders($req->isHttps());

function renderError(Request $req, int $status, string $message, array $extra = []): never
{
    if ($req->isApi()) {
        Response::json(['error' => $message] + $extra, $status);
    }
    $titles = [403 => 'Access denied', 404 => 'Not found', 405 => 'Not allowed', 429 => 'Too many requests'];
    $html = View::partial('error', ['status' => $status, 'title' => $titles[$status] ?? 'Error', 'message' => $message]);
    Response::html($html, $status);
}

try {
    $router = new Router();
    (require dirname(__DIR__) . '/app/routes.php')($router);

    // Password gate of protected websites: stateless, answers without the dashboard session.
    if (str_starts_with($req->path, '/gate/')) {
        \WebManager\Controllers\GateController::handle($req);
    }

    // /api/v1 accepts a personal API token instead of the session cookie (no session, no CSRF); every other path ignores Authorization
    $bearer = ApiV1::isV1($req->path) ? ApiToken::bearer($req) : null;
    if ($bearer !== null) {
        Auth::actAsToken(ApiToken::authenticate($req, $bearer));
    } else {
        Auth::start($req);
    }

    // the stable /api/v1 surface is an allowlist mapped onto the internal routes, so all permission rules stay the same
    if (ApiV1::isV1($req->path)) {
        $internal = ApiV1::resolve($req->method, $req->path);
        if ($internal === null) {
            throw new HttpException(404, 'Unknown API endpoint.');
        }
        $req = $req->withPath($internal);
    }

    $match = $router->match($req->method, $req->path);
    if ($match === null) {
        if ($router->pathExists($req->path)) {
            throw new HttpException(405, 'Method not allowed');
        }
        throw new HttpException(404, 'The page was not found.');
    }
    [$handler, $params, $needsAuth] = $match;

    if ($needsAuth && Auth::user() === null) {
        if ($req->isApi()) {
            throw new HttpException(401, 'Not signed in');
        }
        Response::redirect('/app');
    }
    if ($needsAuth) {
        \WebManager\Http\Permissions::check($req);
        // mandatory 2FA: until it is set up, only the account page (and logout) is reachable
        if (!preg_match('#^/(account|logout)$|^/api/account(/|$)|^/api/v1/me$#', $req->path) && Auth::twoFactorMissing()) {
            if ($req->isApi()) {
                throw new HttpException(403, 'Two-factor authentication is mandatory. Please set it up first under “My account”.');
            }
            Response::redirect('/account');
        }
    }
    if (!in_array($req->method, ['GET', 'HEAD', 'OPTIONS'], true) && $needsAuth && !Auth::viaToken()) {
        // CSRF for every state-changing request; /login and /logout verify their own form token
        Auth::checkCsrf($req);
    }
    // Defence in depth: refuse cross-site requests that carry an Origin header for a different host.
    $origin = $req->header('Origin');
    if ($origin !== '' && !in_array($req->method, ['GET', 'HEAD'], true)) {
        $oh = parse_url($origin, PHP_URL_HOST);
        $host = parse_url('http://' . ($req->header('X-Forwarded-Host') ?: $req->header('Host')), PHP_URL_HOST);
        if (!is_string($oh) || !is_string($host) || strcasecmp($oh, $host) !== 0) {
            Audit::log('security.origin_mismatch', $req->path, ['origin' => mb_substr($origin, 0, 100)]);
            throw new HttpException(403, 'Request from a foreign origin rejected.');
        }
    }

    $handler($req, $params);
    // handlers terminate with Response::*; reaching this point means a handler returned
    throw new HttpException(500, 'No response produced');
} catch (HttpException $e) {
    renderError($req, $e->status, $e->getMessage(), $e->extra);
} catch (\Throwable $e) {
    error_log(sprintf('[webmanager] %s: %s in %s:%d', get_class($e), $e->getMessage(), $e->getFile(), $e->getLine()));
    renderError($req, 500, 'Internal error. Details are in the container log of the dashboard.');
}
