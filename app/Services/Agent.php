<?php
declare(strict_types=1);

namespace WebManager\Services;

use WebManager\Http\HttpException;
use WebManager\Support\Env;

/**
 * Client for the privileged agent. The dashboard only holds the "dashboard" token:
 * it can read status/logs and work on site files, but cannot create or start containers.
 */
final class Agent
{
    /**
     * @param array<string,mixed>|null $json
     * @return array<string,mixed>
     */
    public static function request(string $method, string $path, ?array $json = null, ?string $raw = null, int $timeout = 15): array
    {
        $ch = curl_init(rtrim(Env::get('AGENT_URL', 'http://agent:9000') ?? '', '/') . $path);
        $headers = ['Authorization: Bearer ' . Env::require('AGENT_TOKEN_DASHBOARD')];
        $body = null;
        if ($raw !== null) {
            $body = $raw;
            $headers[] = 'Content-Type: application/octet-stream';
        } elseif ($json !== null) {
            $body = json_encode($json, JSON_UNESCAPED_UNICODE);
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        }
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        if ($out === false) {
            throw new HttpException(503, 'Management service (agent) not reachable: ' . $err);
        }
        $data = json_decode((string) $out, true);
        if (!is_array($data)) {
            $data = [];
        }
        if ($status < 200 || $status >= 300) {
            $code = $status === 401 || $status === 403 ? 502 : ($status >= 400 && $status < 500 ? $status : 502);
            throw new HttpException($code, (string) ($data['error'] ?? "Agent answered with HTTP $status"));
        }
        return $data;
    }

    /** @return array<string,mixed> */
    public static function get(string $path, int $timeout = 15): array
    {
        return self::request('GET', $path, null, null, $timeout);
    }

    /** Streams a local file to the agent (used for uploads, avoids loading it into memory). @return array<string,mixed> */
    public static function putFile(string $path, string $localFile, int $timeout = 600): array
    {
        $fh = fopen($localFile, 'rb');
        if ($fh === false) {
            throw new HttpException(500, 'Uploaded file not readable');
        }
        $ch = curl_init(rtrim(Env::get('AGENT_URL', 'http://agent:9000') ?? '', '/') . $path);
        curl_setopt_array($ch, [
            CURLOPT_PUT => true,
            CURLOPT_INFILE => $fh,
            CURLOPT_INFILESIZE => (int) filesize($localFile),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => $timeout,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_HTTPHEADER => ['Authorization: Bearer ' . Env::require('AGENT_TOKEN_DASHBOARD'), 'Content-Type: application/octet-stream'],
        ]);
        $out = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $err = curl_error($ch);
        fclose($fh);
        if ($out === false) {
            throw new HttpException(503, 'Management service (agent) not reachable: ' . $err);
        }
        $data = json_decode((string) $out, true);
        $data = is_array($data) ? $data : [];
        if ($status < 200 || $status >= 300) {
            throw new HttpException($status >= 400 && $status < 500 && $status !== 401 && $status !== 403 ? $status : 502, (string) ($data['error'] ?? "Agent answered with HTTP $status"));
        }
        return $data;
    }

    /**
     * Streams a file download from the agent directly to the client. With `$json` the agent is asked with a POST (a ZIP archive of a
     * selection); `$mime` is the content type for the client.
     * @param array<string,mixed>|null $json
     */
    public static function download(string $path, string $filename, ?array $json = null, string $mime = 'application/octet-stream'): never
    {
        $ch = curl_init(rtrim(Env::get('AGENT_URL', 'http://agent:9000') ?? '', '/') . $path);
        $sent = false;
        $headers = ['Authorization: Bearer ' . Env::require('AGENT_TOKEN_DASHBOARD')];
        if ($json !== null) {
            $headers[] = 'Content-Type: application/json';
            curl_setopt($ch, CURLOPT_POST, true);
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($json, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
        }
        curl_setopt_array($ch, [
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_TIMEOUT => 600,
            CURLOPT_CONNECTTIMEOUT => 3,
            CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$sent, $filename, $mime) {
                if (!$sent) {
                    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                    if ($code !== 200) {
                        http_response_code($code ?: 502);
                        header('Content-Type: application/json');
                    } else {
                        header('Content-Type: ' . $mime);
                        header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($filename));
                    }
                    $sent = true;
                }
                echo $chunk;
                return strlen($chunk);
            },
        ]);
        curl_exec($ch);
        exit;
    }
}
