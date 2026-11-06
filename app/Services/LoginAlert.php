<?php
declare(strict_types=1);

namespace WebManager\Services;

use WebManager\Http\Request;
use WebManager\Support\Db;

/** Queues the "someone signed in" mail to the person who signed in. The worker sends it; a failure never blocks the sign-in. */
final class LoginAlert
{
    /** @param array<string,mixed> $user needs id, email, name */
    public static function queue(Request $req, array $user): void
    {
        try {
            $s = array_column(Db::all("SELECT k, v FROM settings WHERE k IN ('smtp_host', 'smtp_from', 'smtp_user', 'notify_login')"), 'v', 'k');
            if (($s['notify_login'] ?? '1') !== '1' || ($s['smtp_host'] ?? '') === '' || (($s['smtp_from'] ?? '') === '' && ($s['smtp_user'] ?? '') === '')) {
                return;
            }
            JobQueue::enqueue('mail.login', null, 'Sign-in notice by email', [
                'to' => (string) $user['email'],
                'name' => (string) ($user['name'] ?? ''),
                'ip' => $req->ip(),
                'ua' => mb_substr($req->userAgent(), 0, 200),
                'at' => gmdate('c'),
            ]);
        } catch (\Throwable) {
            // best effort
        }
    }
}
