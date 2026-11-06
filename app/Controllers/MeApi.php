<?php
declare(strict_types=1);

namespace WebManager\Controllers;

use WebManager\Http\Auth;
use WebManager\Http\Request;
use WebManager\Http\Response;
use WebManager\Support\Brand;

/** GET /api/v1/me: who is calling, with which role, and what the single-page shell needs to get started. */
final class MeApi
{
    public static function show(Request $req): never
    {
        $u = Auth::user() ?? [];
        Response::json([
            'user' => ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name'], 'role' => $u['role']],
            'auth' => Auth::viaToken() ? 'token' : 'session',
            // only a browser session needs it; a token never sends cookies, so there is nothing to protect
            'csrf' => Auth::viaToken() ? null : Auth::csrf(),
            'two_factor_missing' => Auth::twoFactorMissing(),
            'brand' => ['name' => Brand::name(), 'product' => Brand::PRODUCT, 'logo' => Brand::logoUrl()],
            'version' => WM_VERSION,
        ]);
    }
}
