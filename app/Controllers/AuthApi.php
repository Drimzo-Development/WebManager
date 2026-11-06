<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\HttpException;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Audit;
use WebManager\Support\Brand;

/**
 * Sign-in for the single-page interface, as JSON. Same rules as every sign-in (rate limits, 2FA, session
 * regeneration, CSRF token bound to the session); only the transport differs. Passkeys keep using /login/passkey/*.
 * Public routes: they only ever act on the caller's own session.
 */
final class AuthApi
{
    /** @return array<string,mixed> what the client needs to decide between login, second step and app */
    private static function state(Request $req): array
    {
        $user = Auth::user();
        return [
            'authenticated' => $user !== null,
            'csrf' => Auth::csrf(),
            'pending_2fa' => $user === null ? Auth::pendingMethods() : null,
            'passkeys_possible' => AccountApi::rp($req) !== null,
            'brand' => ['name' => Brand::name(), 'product' => Brand::PRODUCT, 'logo' => Brand::logoUrl()],
        ];
    }

    public static function show(Request $req): never
    {
        Response::json(self::state($req));
    }

    public static function login(Request $req): never
    {
        Auth::checkCsrf($req);
        $in = $req->json();
        $err = Auth::attempt($req, (string) ($in['email'] ?? ''), (string) ($in['password'] ?? ''));
        // 403/429, never 401: the client treats 401 as "signed out" and would loop back to the login
        if ($err !== null && $err !== Auth::NEEDS_2FA) {
            throw new HttpException(str_starts_with($err, 'Too many') ? 429 : 403, $err);
        }
        // attempt() regenerates the session, so the token changed
        Response::json(self::state($req));
    }

    public static function twoFactor(Request $req): never
    {
        Auth::checkCsrf($req);
        if (!Auth::hasPendingTwoFactor()) {
            throw new HttpException(409, 'The sign-in has expired. Please sign in again.');
        }
        $err = Auth::completeTwoFactor($req, (string) ($req->json()['code'] ?? ''));
        if ($err !== null) {
            throw new HttpException(str_starts_with($err, 'Too many') ? 429 : 403, $err);
        }
        Response::json(self::state($req));
    }

    /** Abandons a half finished login (password entered, second factor pending). */
    public static function cancel(Request $req): never
    {
        Auth::checkCsrf($req);
        unset($_SESSION['pending_2fa'], $_SESSION['pk_auth'], $_SESSION['pk_login']);
        Response::json(self::state($req));
    }

    public static function logout(Request $req): never
    {
        Auth::checkCsrf($req);
        if (Auth::user() !== null) {
            Audit::log('auth.logout', (string) Auth::user()['email']);
        }
        Auth::destroy();
        // a fresh session (and token) for the next login, as after every destroy()
        session_start();
        $_SESSION['csrf'] = bin2hex(random_bytes(32));
        Response::json(self::state($req));
    }
}
