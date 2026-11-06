<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\View;

/** The dashboard is a single-page app (frontend/); the server only delivers its shell and handles the sign-out. */
final class PageController
{
    /** Start page: the app, which shows its own sign-in when nobody is signed in. */
    public static function home(): never
    {
        Response::redirect('/app');
    }

    /** The sign-in lives in the app; old bookmarks of /login end up there. */
    public static function loginForm(Request $req): never
    {
        Response::redirect('/app');
    }

    public static function logout(Request $req): never
    {
        Auth::checkCsrf($req);
        \WebManager\Support\Audit::log('auth.logout', (string) (Auth::user()['email'] ?? ''));
        Auth::destroy();
        Response::redirect('/app');
    }

    /** Shell of the frontend (built from frontend/); it renders client side from the JSON API. */
    public static function shell(): never
    {
        Response::html(View::partial('shell', ['dist' => is_file(WM_ROOT . '/public/assets/app/app.js')]));
    }
}
