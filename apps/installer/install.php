<?php
/**
 * Pathshala installer — PHP bootstrap for cPanel shared hosting (docs/HOSTING-CPANEL.md §2 steps 1–6).
 * PHP is always present on cPanel, so this file is what Apache runs the first time the domain is opened.
 * It detects Node, creates (or falls back for) the database, writes .env and the Passenger .htaccess,
 * adds the cron line when uapi is available, then hands over to the Node app at /install.
 * Everything is idempotent and resumable: state lives in uploads/installer/state.json.
 * Deleted by the Node installer when setup completes.
 */
declare(strict_types=1);
error_reporting(E_ALL);
ini_set('display_errors', '0');
@set_time_limit(120);

$root = __DIR__;
$stateDir = $root . '/uploads/installer';
@mkdir($stateDir, 0755, true);
@mkdir($root . '/uploads/logs', 0755, true);
@mkdir($root . '/storage/sqlite', 0755, true);
$stateFile = $stateDir . '/state.json';
$state = is_file($stateFile) ? (json_decode((string)file_get_contents($stateFile), true) ?: []) : [];
$state['steps'] = $state['steps'] ?? [];

function save(array $state, string $file): void { file_put_contents($file, json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)); }
function mark(array &$state, string $step, string $status, $detail = null): void { $state['steps'][$step] = ['status' => $status, 'detail' => $detail, 'at' => date('c')]; }
function done(array $state, string $step): bool { return ($state['steps'][$step]['status'] ?? '') === 'done'; }
function canExec(): bool { return function_exists('exec') && !in_array('exec', array_map('trim', explode(',', (string)ini_get('disable_functions'))), true); }
function run(string $cmd, ?int &$code = null): string { if (!canExec()) { $code = 127; return ''; } $out = []; @exec($cmd . ' 2>&1', $out, $code); return implode("\n", $out); }
function rnd(int $bytes): string { return bin2hex(random_bytes($bytes)); }
function envQuote(string $v): string { return preg_match('/[\s#"\']/', $v) ? '"' . addcslashes($v, '"\\') . '"' : $v; }
function writeEnv(string $file, array $values): void {
    $lines = is_file($file) ? preg_split('/\r?\n/', (string)file_get_contents($file)) : [];
    $seen = [];
    foreach ($lines as $i => $line) {
        if (preg_match('/^([A-Z0-9_]+)=/', $line, $m) && array_key_exists($m[1], $values)) { $lines[$i] = $m[1] . '=' . envQuote((string)$values[$m[1]]); $seen[$m[1]] = true; }
    }
    foreach ($values as $k => $v) if (!isset($seen[$k])) $lines[] = $k . '=' . envQuote((string)$v);
    file_put_contents($file, rtrim(implode("\n", array_filter($lines, fn($l) => $l !== null))) . "\n");
}
function appUrl(): string {
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https') || (($_SERVER['HTTP_CF_VISITOR'] ?? '') !== '' && str_contains((string)$_SERVER['HTTP_CF_VISITOR'], 'https'));
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $dir = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/\\');
    return ($https ? 'https' : 'http') . '://' . $host . $dir;
}

$log = [];
$note = function (string $m) use (&$log) { $log[] = $m; };

/* ---------- 1. Node ---------- */
if (!done($state, 'node')) {
    $candidates = [];
    foreach ([22, 24, 20] as $v) { $p = "/opt/alt/alt-nodejs$v/root/usr/bin/node"; if (is_file($p)) $candidates[] = $p; }
    $home = getenv('HOME') ?: (isset($_SERVER['HOME']) ? $_SERVER['HOME'] : dirname($root));
    foreach ((array)glob($home . '/nodevenv/*/*/bin/node') as $p) $candidates[] = $p;
    foreach ((array)glob('/opt/alt/alt-nodejs*/root/usr/bin/node') as $p) $candidates[] = $p;
    $which = trim(run('which node'));
    if ($which !== '' && is_file($which)) $candidates[] = $which;
    $candidates = array_values(array_unique($candidates));
    $node = null; $version = null;
    foreach ($candidates as $c) {
        $out = trim(run(escapeshellarg($c) . ' --version'));
        if (preg_match('/^v(\d+)\./', $out, $m)) { if ((int)$m[1] >= 22) { $node = $c; $version = $out; break; } if ($node === null) { $node = $c; $version = $out; } }
        elseif (!canExec() && $node === null) { $node = $c; $version = 'unknown (exec disabled)'; }
    }
    if ($node) { mark($state, 'node', 'done', ['path' => $node, 'version' => $version]); $note("Node: $node $version"); }
    else { mark($state, 'node', 'failed', ['candidates' => $candidates]); $note('Node.js not found.'); }
    save($state, $stateFile);
}

/* ---------- 2. Database ---------- */
if (done($state, 'node') && !done($state, 'db')) {
    $db = null;
    $envFile = $root . '/.env';
    if (is_file($envFile) && preg_match('/^DB_ENGINE=mysql/m', (string)file_get_contents($envFile)) && preg_match('/^DB_PASSWORD=(.+)$/m', (string)file_get_contents($envFile))) {
        $db = ['engine' => 'mysql', 'reused' => true]; $note('Database: reusing existing .env');
    }
    if (!$db && canExec()) {
        $ver = trim(run('uapi --version', $code));
        if ($code === 0) {
            $user = trim(run('whoami')) ?: (getenv('USER') ?: 'user');
            $prefix = substr($user, 0, 8);
            $dbName = $prefix . '_pathshala'; $dbUser = $prefix . '_pathshala'; $dbPass = rnd(12);
            $ok = true;
            $r1 = run('uapi --output=jsonpretty Mysql create_database name=' . escapeshellarg($dbName));
            if (!preg_match('/"status"\s*:\s*1/', $r1) && !preg_match('/already exists/i', $r1)) $ok = false;
            $r2 = run('uapi --output=jsonpretty Mysql create_user name=' . escapeshellarg($dbUser) . ' password=' . escapeshellarg($dbPass));
            if (!preg_match('/"status"\s*:\s*1/', $r2)) { if (preg_match('/already exists/i', $r2)) { run('uapi --output=jsonpretty Mysql set_password user=' . escapeshellarg($dbUser) . ' password=' . escapeshellarg($dbPass)); } else $ok = false; }
            $r3 = run('uapi --output=jsonpretty Mysql set_privileges_on_database user=' . escapeshellarg($dbUser) . ' database=' . escapeshellarg($dbName) . ' privileges=ALL');
            if (!preg_match('/"status"\s*:\s*1/', $r3)) $ok = false;
            if ($ok) { $db = ['engine' => 'mysql', 'host' => 'localhost', 'port' => 3306, 'name' => $dbName, 'user' => $dbUser, 'pass' => $dbPass, 'via' => 'uapi']; $note("Database: MySQL $dbName created via uapi"); }
            else $note('uapi could not create the database: ' . substr($r1 . $r2 . $r3, 0, 300));
        }
    }
    if (!$db) {
        $home = getenv('HOME') ?: dirname($root);
        $my = $home . '/.my.cnf';
        if (is_file($my) && preg_match('/user\s*=\s*(\S+)/', (string)file_get_contents($my), $u) && preg_match('/password\s*=\s*"?([^"\n]+)"?/', (string)file_get_contents($my), $p)) {
            $prefix = substr($u[1], 0, 8);
            $db = ['engine' => 'mysql', 'host' => 'localhost', 'port' => 3306, 'name' => $prefix . '_pathshala', 'user' => $u[1], 'pass' => $p[1], 'via' => '.my.cnf', 'needs_create' => true];
            $note('Database: MySQL credentials from ~/.my.cnf (database created at first boot)');
        }
    }
    if (!$db) { $db = ['engine' => 'sqlite', 'path' => 'storage/sqlite/pathshala.db']; $note('Database: SQLite fallback (migrate to MySQL later from Settings → Hosting)'); }
    if ($db['engine'] === 'mysql' && !empty($db['host']) && function_exists('mysqli_connect')) {
        $m = @mysqli_connect($db['host'], $db['user'], $db['pass']);
        if ($m) { @mysqli_query($m, 'CREATE DATABASE IF NOT EXISTS `' . $db['name'] . '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); @mysqli_close($m); $db['verified'] = true; }
        elseif (empty($db['reused'])) { $note('MySQL login failed (' . mysqli_connect_error() . '); using SQLite'); $db = ['engine' => 'sqlite', 'path' => 'storage/sqlite/pathshala.db']; }
    }
    mark($state, 'db', 'done', array_diff_key($db, ['pass' => 1]));
    $state['db'] = $db;
    save($state, $stateFile);
}

/* ---------- 3. .env ---------- */
if (done($state, 'db') && !done($state, 'env')) {
    $db = $state['db'];
    $values = ['APP_ENV' => 'production', 'APP_URL' => appUrl(), 'APP_KEY' => rnd(32), 'CRON_KEY' => rnd(16), 'ADAPTERS' => 'db,inprocess,local,pdfmake,sse', 'CRON_MODE' => 'heartbeat', 'UPLOADS_DIR' => 'uploads', 'DB_DIR' => 'db', 'FONTS_DIR' => 'app/node_modules/@pathshala/adapters/fonts', 'LOG_LEVEL' => 'info'];
    if (($db['engine'] ?? '') === 'mysql' && empty($db['reused'])) $values += ['DB_ENGINE' => 'mysql', 'DB_HOST' => $db['host'], 'DB_PORT' => (string)$db['port'], 'DB_NAME' => $db['name'], 'DB_USER' => $db['user'], 'DB_PASSWORD' => $db['pass']];
    elseif (($db['engine'] ?? '') === 'sqlite') $values += ['DB_ENGINE' => 'sqlite', 'SQLITE_PATH' => $db['path']];
    $envFile = $root . '/.env';
    if (is_file($envFile)) { unset($values['APP_KEY'], $values['CRON_KEY']); }
    writeEnv($envFile, $values);
    @chmod($envFile, 0600);
    mark($state, 'env', 'done', ['file' => '.env']); $note('.env written');
    save($state, $stateFile);
}

/* ---------- 4. .htaccess (Passenger) ---------- */
if (done($state, 'env') && !done($state, 'htaccess')) {
    $node = $state['steps']['node']['detail']['path'] ?? '';
    $appRoot = $root . '/app';
    $logFile = $root . '/uploads/logs/passenger.log';
    $base = rtrim(dirname($_SERVER['SCRIPT_NAME'] ?? '/'), '/\\'); $base = $base === '' ? '/' : $base;
    $ht = "# Pathshala — written by install.php (Passenger / cPanel \"Setup Node.js App\")\n";
    $ht .= "PassengerEnabled On\nPassengerAppRoot \"$appRoot\"\nPassengerBaseURI \"$base\"\nPassengerAppType node\nPassengerStartupFile server.js\n";
    if ($node) $ht .= "PassengerNodejs \"$node\"\n";
    $ht .= "PassengerAppLogFile \"$logFile\"\nPassengerFriendlyErrorPages off\nPassengerMinInstances 1\n";
    $ht .= "<IfModule mod_env.c>\n  SetEnv APP_ROOT \"$root\"\n  SetEnv NODE_ENV production\n</IfModule>\n";
    $ht .= "<IfModule mod_headers.c>\n  <FilesMatch \"\\.(js|css|woff2|png|svg|webp)$\">\n    Header set Cache-Control \"public, max-age=31536000, immutable\"\n  </FilesMatch>\n</IfModule>\n";
    $ht .= "<FilesMatch \"^(\\.env|state\\.json)$\">\n  Require all denied\n</FilesMatch>\n";
    $ht .= "RewriteEngine On\nRewriteRule ^uploads/(logs|installer|backups)/ - [F]\nRewriteRule ^(db|storage)/ - [F]\n";
    $old = $root . '/.htaccess';
    if (is_file($old) && !str_contains((string)file_get_contents($old), 'Pathshala')) @copy($old, $root . '/uploads/installer/htaccess.backup');
    file_put_contents($old, $ht);
    @mkdir($appRoot . '/tmp', 0755, true); @touch($appRoot . '/tmp/restart.txt');
    mark($state, 'htaccess', 'done', ['node' => $node, 'appRoot' => $appRoot]); $note('.htaccess written (Passenger)');
    save($state, $stateFile);
}

/* ---------- 5. Cron ---------- */
if (done($state, 'htaccess') && !done($state, 'cron')) {
    $env = (string)file_get_contents($root . '/.env');
    preg_match('/^CRON_KEY=(.+)$/m', $env, $k); $cronKey = trim($k[1] ?? '', "\"'");
    $url = appUrl() . '/cron/tick?key=' . $cronKey;
    $mode = 'heartbeat';
    if (canExec()) {
        $list = run('uapi --output=jsonpretty Cron list_cron');
        if (str_contains($list, '/cron/tick')) $mode = 'cron';
        else { $r = run('uapi --output=jsonpretty Cron add_line line=' . escapeshellarg("* * * * * curl -s '$url' >/dev/null 2>&1")); if (preg_match('/"status"\s*:\s*1/', $r)) $mode = 'cron'; }
    }
    writeEnv($root . '/.env', ['CRON_MODE' => $mode]);
    mark($state, 'cron', 'done', ['mode' => $mode]); $note("Cron: $mode");
    save($state, $stateFile);
}

/* ---------- 6. Hand over ---------- */
$allDone = done($state, 'cron');
$nodeMissing = ($state['steps']['node']['status'] ?? '') === 'failed';
$appUrl = appUrl();
if ($allDone && !isset($_GET['status'])) {
    // Probe the Node app; if Passenger is up, go to the wizard.
    $probe = @file_get_contents($appUrl . '/_health', false, stream_context_create(['http' => ['timeout' => 8, 'ignore_errors' => true], 'ssl' => ['verify_peer' => false, 'verify_peer_name' => false]]));
    if ($probe !== false && str_contains($probe, '"ok"')) { header('Location: ' . $appUrl . '/install', true, 302); exit; }
}
header('Content-Type: text/html; charset=utf-8');
?>
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pathshala installer</title>
<?php if ($allDone && !$nodeMissing): ?><meta http-equiv="refresh" content="6;url=<?= htmlspecialchars($appUrl) ?>/install"><?php endif; ?>
<style>body{font-family:system-ui,sans-serif;background:#F2F4F7;color:#17202A;margin:0;padding:32px 16px}main{max-width:640px;margin:0 auto;background:#fff;border:1px solid #D4DBE2;border-radius:10px;padding:24px}h1{margin:0 0 4px;font-size:22px}p{color:#5F6C79}ol{padding-left:20px}li{margin:6px 0}.ok{color:#1E7F4F}.bad{color:#B9352F}code{font-family:ui-monospace,monospace;background:#EAEEF2;padding:1px 5px;border-radius:4px}a.btn{display:inline-block;margin-top:12px;background:#2B5FA8;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none}</style></head>
<body><main>
<h1>Pathshala installer</h1><p>Zero-touch setup on cPanel. Nothing to type; this page only reports progress.</p>
<ol>
<?php foreach (['node' => 'Node.js', 'db' => 'Database', 'env' => 'Configuration (.env)', 'htaccess' => 'Passenger (.htaccess)', 'cron' => 'Scheduler'] as $k => $label): $s = $state['steps'][$k] ?? null; ?>
<li><strong><?= $label ?></strong>: <?php if (!$s): ?>pending<?php elseif ($s['status'] === 'done'): ?><span class="ok">done</span> <small><?= htmlspecialchars(is_array($s['detail']) ? implode(' · ', array_map(fn($v) => is_scalar($v) ? (string)$v : json_encode($v), array_slice($s['detail'], 0, 3))) : (string)$s['detail']) ?></small><?php else: ?><span class="bad"><?= htmlspecialchars($s['status']) ?></span><?php endif; ?></li>
<?php endforeach; ?>
</ol>
<?php if ($nodeMissing): ?>
<p class="bad"><strong>Node.js was not found on this account.</strong> This is the one step a host may require by hand:</p>
<ol><li>Open cPanel → <em>Setup Node.js App</em> → <em>Create Application</em>.</li><li>Node version <code>22</code>, application root <code><?= htmlspecialchars(basename($root)) ?>/app</code>, application URL <code>/</code>, startup file <code>server.js</code>.</li><li>Come back to this page and reload.</li></ol>
<a class="btn" href="?retry=1">Reload</a>
<?php elseif ($allDone): ?>
<p class="ok">All set. Handing over to the app… (Passenger starts Node the first time; this can take up to a minute.)</p>
<a class="btn" href="<?= htmlspecialchars($appUrl) ?>/install">Continue to setup</a>
<?php else: ?>
<a class="btn" href="?retry=1">Continue</a>
<?php endif; ?>
<?php if ($log): ?><p><small><?= htmlspecialchars(implode(' · ', $log)) ?></small></p><?php endif; ?>
<p><small>exec(): <?= canExec() ? 'available' : 'disabled' ?> · PHP <?= PHP_VERSION ?> · <a href="?status=1">status</a></small></p>
</main></body></html>
