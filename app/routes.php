<?php
declare(strict_types=1);

use WebManager\Controllers\AccessApi;
use WebManager\Controllers\AccountApi;
use WebManager\Controllers\AuthApi;
use WebManager\Controllers\BackupApi;
use WebManager\Controllers\BrandingApi;
use WebManager\Controllers\CronApi;
use WebManager\Controllers\DatabaseApi;
use WebManager\Controllers\DnsApi;
use WebManager\Controllers\FileApi;
use WebManager\Controllers\JobApi;
use WebManager\Controllers\LangApi;
use WebManager\Controllers\MaintenanceApi;
use WebManager\Controllers\MeApi;
use WebManager\Controllers\MetricsApi;
use WebManager\Controllers\ConsoleApi;
use WebManager\Controllers\NotificationsApi;
use WebManager\Controllers\PasskeyLoginApi;
use WebManager\Controllers\PageController as P;
use WebManager\Controllers\ProtectionApi;
use WebManager\Controllers\ReportApi;
use WebManager\Controllers\SiteApi;
use WebManager\Controllers\StorageApi;
use WebManager\Controllers\SystemApi;
use WebManager\Controllers\TokenApi;
use WebManager\Controllers\UpdateApi;
use WebManager\Controllers\UsersApi;
use WebManager\Http\Router;

return static function (Router $r): void {
    // public
    $r->add('GET', '/healthz', [SystemApi::class, 'health'], false);
    $r->add('GET', '/brand/logo', [BrandingApi::class, 'logo'], false);
    $r->add('GET', '/brand/theme.css', [BrandingApi::class, 'theme'], false);
    $r->add('GET', '/login', [P::class, 'loginForm'], false);
    $r->add('GET', '/login/2fa', [P::class, 'loginForm'], false);
    $r->add('POST', '/login/passkey/signin/options', [PasskeyLoginApi::class, 'signinOptions'], false);
    $r->add('POST', '/login/passkey/signin/verify', [PasskeyLoginApi::class, 'signinVerify'], false);
    $r->add('POST', '/login/passkey/options', [PasskeyLoginApi::class, 'options'], false);
    $r->add('POST', '/login/passkey/verify', [PasskeyLoginApi::class, 'verify'], false);
    $r->add('POST', '/logout', [P::class, 'logout']);

    // the start page is the app; the shell shows the sign-in itself when nobody is signed in (it holds no data)
    $r->add('GET', '/', [P::class, 'home'], false);
    $r->add('GET', '/app', [P::class, 'shell'], false);
    // JSON sign-in for the app; each action verifies the CSRF token of the caller's own session
    $r->add('GET', '/api/auth/state', [AuthApi::class, 'show'], false);
    // language files for the interface (also needed before sign-in)
    $r->add('GET', '/api/lang', [LangApi::class, 'index'], false);
    $r->add('GET', '/api/lang/{code}', [LangApi::class, 'show'], false);
    $r->add('POST', '/api/auth/login', [AuthApi::class, 'login'], false);
    $r->add('POST', '/api/auth/2fa', [AuthApi::class, 'twoFactor'], false);
    $r->add('POST', '/api/auth/cancel', [AuthApi::class, 'cancel'], false);
    $r->add('POST', '/api/auth/logout', [AuthApi::class, 'logout'], false);

    // public API v1 (allowlist in WebManager\Http\ApiV1; most routes are served by the internal handlers below) and API tokens
    $r->add('GET', '/api/v1/me', [MeApi::class, 'show']);
    $r->add('GET', '/api/v1/metrics', [MetricsApi::class, 'show']);
    $r->add('GET', '/api/account/tokens', [TokenApi::class, 'list']);
    $r->add('POST', '/api/account/tokens', [TokenApi::class, 'create']);
    $r->add('DELETE', '/api/account/tokens/{id}', [TokenApi::class, 'revoke']);

    // appearance (name, logo, colour)
    $r->add('GET', '/api/branding', [BrandingApi::class, 'show']);
    $r->add('PUT', '/api/branding', [BrandingApi::class, 'update']);
    $r->add('POST', '/api/branding/logo', [BrandingApi::class, 'putLogo']);
    $r->add('DELETE', '/api/branding/logo', [BrandingApi::class, 'deleteLogo']);
    $r->add('DELETE', '/api/branding', [BrandingApi::class, 'reset']);


    // site API
    $r->add('GET', '/api/overview', [SiteApi::class, 'overview']);
    $r->add('GET', '/api/runtimes', [SiteApi::class, 'runtimes']);
    $r->add('GET', '/api/apps', [SiteApi::class, 'apps']);
    $r->add('POST', '/api/sites', [SiteApi::class, 'create']);
    $r->add('GET', '/api/sites/{id}', [SiteApi::class, 'show']);
    $r->add('PUT', '/api/sites/{id}', [SiteApi::class, 'update']);
    $r->add('DELETE', '/api/sites/{id}', [SiteApi::class, 'delete']);
    $r->add('POST', '/api/sites/{id}/duplicate', [SiteApi::class, 'duplicate']);
    $r->add('POST', '/api/sites/{id}/action', [SiteApi::class, 'action']);
    $r->add('GET', '/api/sites/{id}/status', [SiteApi::class, 'status']);
    $r->add('GET', '/api/sites/{id}/logs', [SiteApi::class, 'logs']);
    $r->add('GET', '/api/sites/{id}/env', [SiteApi::class, 'getEnv']);
    $r->add('PUT', '/api/sites/{id}/env', [SiteApi::class, 'putEnv']);
    $r->add('PUT', '/api/sites/{id}/domains', [SiteApi::class, 'putDomains']);
    $r->add('GET', '/api/sites/{id}/webserver', [SiteApi::class, 'getWebserver']);
    $r->add('PUT', '/api/sites/{id}/webserver', [SiteApi::class, 'putWebserver']);
    $r->add('GET', '/api/sites/{id}/gate', [AccessApi::class, 'getGate']);
    $r->add('PUT', '/api/sites/{id}/gate', [AccessApi::class, 'putGate']);
    $r->add('POST', '/api/sites/{id}/gate/passwords', [AccessApi::class, 'addPassword']);
    $r->add('DELETE', '/api/sites/{id}/gate/passwords/{pid}', [AccessApi::class, 'deletePassword']);
    $r->add('POST', '/api/sites/{id}/gate/logo', [AccessApi::class, 'putLogo']);
    $r->add('DELETE', '/api/sites/{id}/gate/logo', [AccessApi::class, 'deleteLogo']);
    $r->add('POST', '/api/geo/update', [AccessApi::class, 'updateGeo']);
    $r->add('GET', '/api/sites/{id}/cron', [CronApi::class, 'list']);
    $r->add('POST', '/api/sites/{id}/cron', [CronApi::class, 'create']);
    $r->add('PUT', '/api/sites/{id}/cron/{cid}', [CronApi::class, 'update']);
    $r->add('DELETE', '/api/sites/{id}/cron/{cid}', [CronApi::class, 'delete']);
    $r->add('POST', '/api/sites/{id}/cron/{cid}/run', [CronApi::class, 'run']);
    $r->add('GET', '/api/sites/{id}/database', [DatabaseApi::class, 'show']);
    $r->add('PUT', '/api/sites/{id}/database', [DatabaseApi::class, 'update']);
    $r->add('POST', '/api/sites/{id}/database/manage', [DatabaseApi::class, 'manage']);
    $r->add('POST', '/api/sites/{id}/database/manage/stop', [DatabaseApi::class, 'manageStop']);
    $r->add('GET', '/api/dbadmin/auth', [DatabaseApi::class, 'adminAuth']);
    $r->add('PUT', '/api/sites/{id}/database/external', [DatabaseApi::class, 'external']);
    $r->add('GET', '/api/sites/{id}/database/password', [DatabaseApi::class, 'password']);
    $r->add('POST', '/api/sites/{id}/database/rotate', [DatabaseApi::class, 'rotate']);
    $r->add('POST', '/api/sites/{id}/database/dump', [DatabaseApi::class, 'dump']);
    $r->add('POST', '/api/sites/{id}/database/restore', [DatabaseApi::class, 'restore']);
    $r->add('POST', '/api/sites/{id}/database/purge', [DatabaseApi::class, 'purge']);
    $r->add('GET', '/api/sites/{id}/database/dumps/{name}', [DatabaseApi::class, 'download']);
    $r->add('DELETE', '/api/sites/{id}/database/dumps/{name}', [DatabaseApi::class, 'deleteDump']);
    $r->add('GET', '/api/sites/{id}/security', [AccessApi::class, 'getSecurity']);
    $r->add('PUT', '/api/sites/{id}/security', [AccessApi::class, 'putSecurity']);
    $r->add('GET', '/api/sites/{id}/rules', [AccessApi::class, 'getRules']);
    $r->add('PUT', '/api/sites/{id}/rules', [AccessApi::class, 'putRules']);
    $r->add('GET', '/api/sites/{id}/maintenance', [AccessApi::class, 'getMaintenance']);
    $r->add('PUT', '/api/sites/{id}/maintenance', [AccessApi::class, 'putMaintenance']);
    $r->add('POST', '/api/sites/{id}/dns-check', [SiteApi::class, 'dnsCheck']);
    $r->add('POST', '/api/sites/{id}/dns-records', [DnsApi::class, 'siteRecords']);
    // DNS provider (Cloudflare, Hetzner) for wildcard certificates and DNS records (administrators)
    $r->add('GET', '/api/dns', [DnsApi::class, 'show']);
    $r->add('PUT', '/api/dns', [DnsApi::class, 'save']);
    $r->add('DELETE', '/api/dns', [DnsApi::class, 'remove']);
    $r->add('POST', '/api/dns/test', [DnsApi::class, 'test']);
    $r->add('GET', '/api/sites/{id}/cert', [SiteApi::class, 'certStatus']);
    $r->add('POST', '/api/sites/{id}/cert', [SiteApi::class, 'issueCert']);
    $r->add('GET', '/api/sites/{id}/scripts', [SiteApi::class, 'scripts']);
    $r->add('POST', '/api/sites/{id}/commands', [SiteApi::class, 'command']);
    $r->add('GET', '/api/sites/{id}/jobs', [SiteApi::class, 'jobs']);
    $r->add('GET', '/api/sites/{id}/metrics', [SiteApi::class, 'metrics']);
    $r->add('GET', '/api/maintenance', [MaintenanceApi::class, 'list']);
    $r->add('POST', '/api/maintenance', [MaintenanceApi::class, 'create']);
    $r->add('DELETE', '/api/maintenance/{id}', [MaintenanceApi::class, 'delete']);
    $r->add('GET', '/api/sites/{id}/uptime', [SiteApi::class, 'uptime']);
    $r->add('GET', '/api/sites/{id}/resources', [SiteApi::class, 'resources']);
    // web console: terminal page (iframe), one-time ticket, and the check the reverse proxy makes before it forwards the WebSocket
    $r->add('GET', '/console/{id}', [ConsoleApi::class, 'page']);
    $r->add('GET', '/api/sites/{id}/console', [ConsoleApi::class, 'settings']);
    $r->add('PUT', '/api/sites/{id}/console', [ConsoleApi::class, 'saveSettings']);
    $r->add('POST', '/api/sites/{id}/console', [ConsoleApi::class, 'ticket']);
    $r->add('POST', '/api/console/confirm', [ConsoleApi::class, 'confirm']);
    $r->add('GET', '/api/console/ticket/{rid}', [ConsoleApi::class, 'ticketResult']);
    $r->add('POST', '/api/console/sessions/{sid}/kill', [ConsoleApi::class, 'kill']);
    $r->add('GET', '/api/console/auth', [ConsoleApi::class, 'auth']);
    $r->add('GET', '/api/sites/{id}/report', [ReportApi::class, 'get']);
    $r->add('PUT', '/api/sites/{id}/report', [ReportApi::class, 'put']);
    $r->add('POST', '/api/sites/{id}/report/send', [ReportApi::class, 'send']);

    // files
    $r->add('GET', '/api/sites/{id}/files', [FileApi::class, 'list']);
    $r->add('GET', '/api/sites/{id}/files/content', [FileApi::class, 'read']);
    $r->add('PUT', '/api/sites/{id}/files/content', [FileApi::class, 'write']);
    $r->add('POST', '/api/sites/{id}/files/upload', [FileApi::class, 'upload']);
    $r->add('POST', '/api/sites/{id}/files/mkdir', [FileApi::class, 'mkdir']);
    $r->add('POST', '/api/sites/{id}/files/rename', [FileApi::class, 'rename']);
    $r->add('POST', '/api/sites/{id}/files/copy', [FileApi::class, 'copy']);
    $r->add('DELETE', '/api/sites/{id}/files', [FileApi::class, 'delete']);
    $r->add('GET', '/api/sites/{id}/files/download', [FileApi::class, 'download']);
    $r->add('GET', '/api/sites/{id}/files/archive', [FileApi::class, 'archive']);
    $r->add('POST', '/api/sites/{id}/files/zip', [FileApi::class, 'zip']);
    $r->add('POST', '/api/sites/{id}/files/batch', [FileApi::class, 'batch']);

    // jobs
    $r->add('GET', '/api/jobs', [JobApi::class, 'list']);
    $r->add('GET', '/api/jobs/{id}', [JobApi::class, 'show']);
    $r->add('GET', '/api/jobs/{id}/logs', [JobApi::class, 'logs']);
    $r->add('POST', '/api/jobs/{id}/cancel', [JobApi::class, 'cancel']);

    // users (administrators only, see Permissions)
    $r->add('GET', '/api/users', [UsersApi::class, 'list']);
    $r->add('POST', '/api/users', [UsersApi::class, 'create']);
    $r->add('PUT', '/api/users/{id}', [UsersApi::class, 'update']);
    $r->add('POST', '/api/users/{id}/password', [UsersApi::class, 'setPassword']);
    $r->add('POST', '/api/users/{id}/2fa/reset', [UsersApi::class, 'resetTwoFactor']);
    $r->add('DELETE', '/api/users/{id}', [UsersApi::class, 'delete']);

    // system
    $r->add('GET', '/api/system', [SystemApi::class, 'system']);
    $r->add('PUT', '/api/settings/dashboard-domain', [SystemApi::class, 'setDashboardDomain']);
    $r->add('GET', '/api/protection', [ProtectionApi::class, 'show']);
    $r->add('PUT', '/api/protection', [ProtectionApi::class, 'update']);
    $r->add('POST', '/api/protection/unban', [ProtectionApi::class, 'unban']);
    $r->add('GET', '/api/settings/notifications', [NotificationsApi::class, 'get']);
    $r->add('PUT', '/api/settings/notifications', [NotificationsApi::class, 'put']);
    $r->add('POST', '/api/settings/notifications/test', [NotificationsApi::class, 'test']);
    $r->add('GET', '/api/settings/login', [SystemApi::class, 'loginSettings']);
    $r->add('PUT', '/api/settings/login', [SystemApi::class, 'setLoginSettings']);
    $r->add('PUT', '/api/settings/public-url', [SystemApi::class, 'setPublicUrl']);
    $r->add('POST', '/api/account/password', [SystemApi::class, 'changePassword']);
    $r->add('GET', '/api/account', [AccountApi::class, 'show']);
    $r->add('POST', '/api/account/passkeys/options', [AccountApi::class, 'passkeyOptions']);
    $r->add('POST', '/api/account/passkeys', [AccountApi::class, 'passkeyRegister']);
    $r->add('POST', '/api/account/passkeys/{pid}/remove', [AccountApi::class, 'passkeyRemove']);
    $r->add('POST', '/api/account/2fa/setup', [AccountApi::class, 'setup']);
    $r->add('POST', '/api/account/2fa/enable', [AccountApi::class, 'enable']);
    $r->add('POST', '/api/account/2fa/disable', [AccountApi::class, 'disable']);
    $r->add('POST', '/api/account/2fa/recovery', [AccountApi::class, 'recovery']);
    $r->add('GET', '/api/audit', [SystemApi::class, 'audit']);
    $r->add('GET', '/api/audit/export', [SystemApi::class, 'auditExport']);
    $r->add('POST', '/api/system/renew-certificates', [SystemApi::class, 'renewCerts']);
    $r->add('POST', '/api/system/reconcile', [SystemApi::class, 'reconcile']);
    $r->add('GET', '/api/storage', [StorageApi::class, 'show']);
    $r->add('GET', '/api/storage/sites', [StorageApi::class, 'sites']);
    $r->add('POST', '/api/storage/cleanup', [StorageApi::class, 'cleanup']);
    $r->add('GET', '/api/backup', [BackupApi::class, 'show']);
    $r->add('POST', '/api/backup/run', [BackupApi::class, 'run']);
    $r->add('GET', '/api/update', [UpdateApi::class, 'show']);
    $r->add('POST', '/api/update/check', [UpdateApi::class, 'check']);
    $r->add('POST', '/api/update/auto', [UpdateApi::class, 'setAuto']);
    $r->add('POST', '/api/update/rollback', [UpdateApi::class, 'rollback']);
    $r->add('POST', '/api/update/apply', [UpdateApi::class, 'apply']);
};
