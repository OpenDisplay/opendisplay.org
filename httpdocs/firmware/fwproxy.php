<?php
/**
 * fwproxy.php — same-origin proxy for OpenDisplay firmware release assets.
 *
 * GitHub release downloads (github.com/.../releases/download/...) cannot be
 * fetched from the browser: they redirect to a host that sends no
 * Access-Control-Allow-Origin header, so the Toolbox's in-browser installers
 * are blocked by CORS. This script fetches the asset server-side and returns
 * it from our own origin.
 *
 * Usage: fwproxy.php?repo=Firmware&tag=2.26.7&asset=esp32-s3-N16R8_full.bin
 * Health check: fwproxy.php?selftest=1 (the Toolbox checks this before using it)
 *
 * The org is fixed and every input is validated, so this can't be used as a
 * generic open proxy.
 */

const GITHUB_ORG = 'OpenDisplay';
// Repos whose release assets we serve.
const ALLOWED_REPOS = ['Firmware', 'Firmware_NRF', 'Firmware_NRF54', 'Firmware_Silabs'];

header('X-Content-Type-Options: nosniff');

if (isset($_GET['selftest'])) {
    header('Content-Type: text/plain');
    header('Cache-Control: no-store');
    echo 'php-ok ' . PHP_VERSION . "\n";
    echo 'curl ' . (function_exists('curl_init') ? 'ok' : 'MISSING') . "\n";
    exit;
}

$repo  = isset($_GET['repo'])  ? (string) $_GET['repo']  : '';
$tag   = isset($_GET['tag'])   ? (string) $_GET['tag']   : '';
$asset = isset($_GET['asset']) ? (string) $_GET['asset'] : '';

// --- validate -------------------------------------------------------------
if (!in_array($repo, ALLOWED_REPOS, true)) {
    http_response_code(400);
    exit('Invalid repo');
}
// 2.26.7, v1.4, 2.27.0-beta.1
if (!preg_match('/^v?[0-9][0-9.]*(-[A-Za-z0-9.]+)?$/', $tag)) {
    http_response_code(400);
    exit('Invalid tag');
}
// A plain file name with a firmware extension: no paths.
if (!preg_match('/^[A-Za-z0-9._-]+\.(bin|zip|uf2|hex)$/', $asset)) {
    http_response_code(400);
    exit('Invalid asset');
}

$url = sprintf(
    'https://github.com/%s/%s/releases/download/%s/%s',
    GITHUB_ORG, $repo, rawurlencode($tag), rawurlencode($asset)
);

// --- fetch (follow GitHub's signed redirect) ------------------------------
if (!function_exists('curl_init')) {
    http_response_code(500);
    exit('Server missing cURL');
}

$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS      => 5,
    CURLOPT_PROTOCOLS      => CURLPROTO_HTTPS,
    CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT        => 120,
    CURLOPT_USERAGENT      => 'opendisplay-fwproxy',
]);
$data = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
curl_close($ch);

if ($data === false || $code >= 400) {
    http_response_code($code === 404 ? 404 : 502);
    exit('Upstream fetch failed');
}

// --- send back ------------------------------------------------------------
$type = (substr($asset, -4) === '.zip') ? 'application/zip' : 'application/octet-stream';
header('Content-Type: ' . $type);
header('Content-Length: ' . strlen($data));
header('Content-Disposition: attachment; filename="' . $asset . '"');
// Assets are usually fixed per tag, but GitHub allows replacing one on an
// existing release, so cache only briefly.
header('Cache-Control: public, max-age=3600');
echo $data;
