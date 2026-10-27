<?php
/**
 * MGM Pay Naira bridge for a separately hosted, IP-whitelisted PHP domain.
 * PHP 7.4+ with cURL and JSON enabled.
 * Keep credentials in server environment variables or constants in inc/config.php.
 */
header('X-Content-Type-Options: nosniff');

// If this bridge is uploaded into public_html beside the existing inc/ folder,
// load its private PHP configuration. Environment variables take precedence.
$privateConfig = __DIR__ . '/inc/config.php';
if (is_file($privateConfig)) require_once $privateConfig;

final class BridgeError extends RuntimeException {
    public $definite;
    public $httpStatus;
    public function __construct($message, $definite = false, $httpStatus = 502) {
        parent::__construct($message);
        $this->definite = (bool)$definite;
        $this->httpStatus = (int)$httpStatus;
    }
}

function envv($name, $default = '') {
    $v = getenv($name);
    if ($v !== false && trim((string)$v) !== '') return trim((string)$v);
    if (defined($name)) return trim((string)constant($name));
    return $default;
}
function base_url() {
    $env = strtolower(envv('MGM_ENV', 'sandbox'));
    if ($env === 'production' || $env === 'prod') return rtrim(envv('MGM_API_BASE', 'https://api.mgm-pay.com'), '/');
    return rtrim(envv('MGM_API_BASE', 'https://api.mgm-paysandbox.com'), '/');
}
function secret_config() {
    $cfg = [
        'merchant_no' => envv('MGM_MERCHANT_NO'),
        'app_id' => envv('MGM_APP_ID'),
        'collection_key' => envv('MGM_COLLECTION_KEY'),
        'payout_key' => envv('MGM_PAYOUT_KEY'),
        'bridge_secret' => envv('APM_MGM_BRIDGE_SECRET'),
        'public_url' => rtrim(envv('MGM_BRIDGE_PUBLIC_URL'), '/'),
        'app_callback_url' => envv('APM_GATEWAY_CALLBACK_URL'),
        'success_url' => envv('APM_GATEWAY_SUCCESS_URL')
    ];
    foreach (['merchant_no','app_id','collection_key','payout_key','bridge_secret','public_url','app_callback_url'] as $key) {
        if ($cfg[$key] === '') throw new BridgeError('Bridge server configuration is incomplete.', true, 503);
    }
    return $cfg;
}
function json_encode_wire($data) {
    $encoded = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    if ($encoded === false) throw new BridgeError('Could not encode JSON request.', true, 500);
    return $encoded;
}
function send_bridge_json($payload, $status = 200) {
    $secret = envv('APM_MGM_BRIDGE_SECRET');
    if ($secret === '') $secret = 'misconfigured';
    $body = json_encode_wire($payload);
    $ts = (string)round(microtime(true) * 1000);
    header('Content-Type: application/json; charset=utf-8');
    header('X-APM-Timestamp: ' . $ts);
    header('X-APM-Response-Signature: ' . hash_hmac('sha256', $ts . "\n" . hash('sha256', $body), $secret));
    http_response_code($status);
    echo $body;
    exit;
}
function random_nonce($length = 8) {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $bytes = random_bytes($length); $out = '';
    for ($i = 0; $i < $length; $i++) $out .= $alphabet[ord($bytes[$i]) % strlen($alphabet)];
    return $out;
}
function claim_nonce_once($nonce) {
    if (random_int(1, 50) === 1) {
        foreach (glob(rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'apm-mgm-*.nonce') ?: [] as $old) {
            if (@filemtime($old) < time() - 600) @unlink($old);
        }
    }
    $path = rtrim(sys_get_temp_dir(), DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . 'apm-mgm-' . hash('sha256', $nonce) . '.nonce';
    $fp = @fopen($path, 'x');
    if (!$fp) throw new BridgeError('Bridge nonce was already used.', true, 409);
    fwrite($fp, (string)time()); fclose($fp);
}
function is_scalar_field($v) { return !is_array($v) && !is_object($v) && $v !== null && $v !== ''; }
function mgm_signature($fields, $key, $excludeNested = []) {
    unset($fields['signature']);
    foreach ($excludeNested as $nested) unset($fields[$nested]);
    $pairs = [];
    foreach ($fields as $name => $value) {
        if (!is_scalar_field($value)) continue;
        if ((string)$name === 'amount' && is_numeric($value)) $value = number_format((float)$value, 2, '.', '');
        $pairs[(string)$name] = (string)$value;
    }
    uksort($pairs, function($a, $b) { return strcmp($a, $b); });
    $parts = [];
    foreach ($pairs as $name => $value) $parts[] = $name . '=' . $value;
    return strtoupper(md5(implode('&', $parts) . '&key=' . $key));
}
function verify_mgm_data($data, $key, $kind) {
    $signature = isset($data['signature']) ? strtoupper((string)$data['signature']) : '';
    $isCallback = (substr($kind, -9) === '_callback');
    if ($signature === '') {
        if ($isCallback) throw new BridgeError('MGM callback has no signature.', true, 401);
        return true; // response signatures are optional in the provider guide
    }
    $signed = $data;
    if ($kind === 'deposit_callback') {
        $allowed = ['currency','order_id','payment_id','amount','timestamp','extend','status','status_code','status_detail'];
    } elseif ($kind === 'withdrawal_callback') {
        $allowed = ['currency','country','order_id','settlement_id','amount','timestamp','status','status_code','status_detail'];
    } else {
        $allowed = array_keys($data);
    }
    $signed = array_intersect_key($signed, array_flip($allowed));
    $expected = mgm_signature($signed, $key, ['payer','payee']);
    if (!hash_equals($expected, $signature)) throw new BridgeError('MGM Pay response/callback signature verification failed.', $isCallback, 401);
    return true;
}
function mgm_request($path, $data, $key, $nested = []) {
    $cfg = secret_config();
    $timestamp = (string)round(microtime(true) * 1000);
    $nonce = random_nonce(8);
    $data['timestamp'] = $timestamp;
    // Sign the canonical strings, preserving fixed 2-decimal amount values.
    $data['signature'] = mgm_signature($data, $key, $nested);
    $wire = $data;
    if (isset($wire['amount'])) $wire['amount'] = (float)number_format((float)$wire['amount'], 2, '.', '');
    $body = json_encode_wire(['merchant_no' => $cfg['merchant_no'], 'data' => $wire]);
    $headers = [
        'Content-Type: application/json; charset=utf-8',
        'ApiVersion: 1.0',
        'AppId: ' . $cfg['app_id'],
        'Noncestr: ' . $nonce,
        'Timestamp: ' . $timestamp
    ];
    $ch = curl_init(base_url() . $path);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_HTTPHEADER => $headers,
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $raw = curl_exec($ch);
    $curlErr = curl_error($ch); $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($raw === false) throw new BridgeError('MGM Pay network timeout/error: ' . $curlErr, false, 502);
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) throw new BridgeError('MGM Pay returned invalid JSON; reconcile the order before retrying.', false, 502);
    if ($http >= 500) throw new BridgeError('MGM Pay server error; order result may be uncertain. Reconcile before retrying.', false, 502);
    if ($http >= 400 || strtolower((string)($decoded['state'] ?? '')) !== 'ok') {
        throw new BridgeError((string)($decoded['message'] ?? $decoded['msg'] ?? 'MGM Pay rejected the request.'), true, 502);
    }
    $resultData = $decoded['data'] ?? [];
    if (is_array($resultData) && !isset($resultData['signature']) && isset($decoded['signature'])) $resultData['signature'] = $decoded['signature'];
    if (is_array($resultData) && isset($resultData['signature'])) verify_mgm_data($resultData, $key, 'response');
    return $resultData;
}
function bridge_request_signature_message($timestamp, $nonce, $raw) {
    return $timestamp . "\n" . $nonce . "\n" . hash('sha256', $raw);
}
function callback_relay_message($timestamp, $nonce, $hook, $data) {
    $keys = ['order_id','payment_id','settlement_id','amount','currency','country','status_code','status','status_detail'];
    $parts = [$timestamp, $nonce, $hook];
    foreach ($keys as $key) $parts[] = isset($data[$key]) && !is_array($data[$key]) ? (string)$data[$key] : '';
    return implode("\n", $parts);
}
function curl_json($url, $body, $headers = []) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json; charset=utf-8'], $headers),
        CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 8, CURLOPT_TIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
    $raw = curl_exec($ch); $error = curl_error($ch); $http = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    return [$raw, $error, $http];
}
function handle_provider_callback($hook, $raw) {
    $cfg = secret_config();
    $provider = json_decode($raw, true);
    if (!is_array($provider)) throw new BridgeError('Invalid MGM callback JSON.', true, 400);
    $data = isset($provider['data']) && is_array($provider['data']) ? $provider['data'] : $provider;
    if (!isset($data['signature']) && isset($provider['signature'])) $data['signature'] = $provider['signature'];
    $key = $hook === 'deposit' ? $cfg['collection_key'] : $cfg['payout_key'];
    verify_mgm_data($data, $key, $hook . '_callback');
    if (empty($data['order_id']) || !isset($data['amount']) || !isset($data['currency']) || !isset($data['status_code'])) {
        throw new BridgeError('MGM callback is missing required order fields.', true, 400);
    }
    $ts = (string)round(microtime(true) * 1000); $nonce = random_nonce(12);
    $relayBody = json_encode_wire(['hook' => $hook, 'data' => $data]);
    $sig = hash_hmac('sha256', callback_relay_message($ts, $nonce, $hook, $data), $cfg['bridge_secret']);
    list($response, $error, $http) = curl_json($cfg['app_callback_url'], $relayBody, [
        'X-APM-Timestamp: ' . $ts,
        'X-APM-Nonce: ' . $nonce,
        'X-APM-Signature: ' . $sig
    ]);
    if ($response === false || $http < 200 || $http >= 300 || trim((string)$response) !== 'SUCCESS') {
        throw new BridgeError('Could not confirm callback application on the merchant site. MGM Pay should retry.', false, 502);
    }
    header('Content-Type: text/plain; charset=utf-8');
    http_response_code(200); echo 'SUCCESS'; exit;
}
function read_payload($raw) {
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) throw new BridgeError('Invalid JSON request.', true, 400);
    return $decoded;
}
function perform_action($action, $payload) {
    $cfg = secret_config();
    if ($action === 'create_deposit') {
        $orderId = trim((string)($payload['order_id'] ?? ''));
        $amount = number_format((float)($payload['amount'] ?? 0), 2, '.', '');
        if ($orderId === '' || (float)$amount <= 0) throw new BridgeError('Invalid deposit order.', true, 400);
        $data = [
            'country' => 'NG', 'currency' => 'NGN',
            'payment_method_id' => 'BANK_CARD', 'payment_method_flow' => 'REDIRECT',
            'order_id' => $orderId, 'amount' => $amount,
            'notification_url' => $cfg['public_url'] . '?hook=deposit'
        ];
        if ($cfg['success_url'] !== '') $data['success_redirect_url'] = $cfg['success_url'];
        $result = mgm_request('/api/pay/payment', $data, $cfg['collection_key']);
        if (empty($result['redirect_url'])) throw new BridgeError('MGM Pay accepted the order but returned no cashier URL; reconcile this order.', false, 502);
        return $result;
    }
    if ($action === 'create_withdrawal') {
        $orderId = trim((string)($payload['order_id'] ?? ''));
        $amount = number_format((float)($payload['amount'] ?? 0), 2, '.', '');
        $payee = $payload['payee'] ?? [];
        if ($orderId === '' || (float)$amount <= 0 || !is_array($payee)
            || empty($payee['name']) || !preg_match('/^\d{10}$/', (string)($payee['account'] ?? ''))
            || empty($payee['bank_code'])) throw new BridgeError('Invalid payout beneficiary or amount.', true, 400);
        $data = [
            'country' => 'NG', 'currency' => 'NGN', 'order_id' => $orderId,
            'amount' => $amount, 'notification_url' => $cfg['public_url'] . '?hook=withdrawal',
            'payee' => ['name' => (string)$payee['name'], 'account' => (string)$payee['account'],
                'account_type' => 'BANK', 'bank_code' => (string)$payee['bank_code']]
        ];
        return mgm_request('/api/settle/settlement', $data, $cfg['payout_key'], ['payee']);
    }
    if ($action === 'query_deposit' || $action === 'query_withdrawal') {
        $orderId = trim((string)($payload['order_id'] ?? ''));
        if ($orderId === '') throw new BridgeError('Missing order ID.', true, 400);
        $path = $action === 'query_deposit' ? '/api/pay/queryPaymentOrder' : '/api/settle/querySettlementOrder';
        $key = $action === 'query_deposit' ? $cfg['collection_key'] : $cfg['payout_key'];
        $data = ['order_id' => $orderId];
        // Query endpoints use the merchant/order body and common headers; body signature is not documented.
        $result = mgm_request_query($path, $data);
        if (isset($result['signature'])) verify_mgm_data($result, $key, 'response');
        return $result;
    }
    if ($action === 'balance') {
        $signature = strtoupper(md5('merchant_no=' . $cfg['merchant_no'] . '&key=' . $cfg['payout_key']));
        $result = mgm_request_balance('/api/merchant/balance', $signature);
        if (isset($result['signature'])) verify_mgm_data($result, $cfg['payout_key'], 'response');
        return $result;
    }
    throw new BridgeError('Unsupported bridge action.', true, 400);
}
function common_headers($timestamp, $nonce, $appId) {
    return ['Content-Type: application/json; charset=utf-8','ApiVersion: 1.0','AppId: ' . $appId,
        'Noncestr: ' . $nonce,'Timestamp: ' . $timestamp];
}
function mgm_request_query($path, $data) {
    $cfg = secret_config(); $timestamp = (string)round(microtime(true) * 1000); $nonce = random_nonce(8);
    $body = json_encode_wire(['merchant_no'=>$cfg['merchant_no'],'data'=>$data]);
    list($raw,$error,$http)=curl_json(base_url().$path,$body,common_headers($timestamp,$nonce,$cfg['app_id']));
    if ($raw===false) throw new BridgeError('MGM query timed out; reconcile again using the same order ID.',false,502);
    $decoded=json_decode($raw,true);
    if (!is_array($decoded)) throw new BridgeError('Invalid MGM query response.',false,502);
    if ($http>=400 || strtolower((string)($decoded['state']??''))!=='ok') throw new BridgeError((string)($decoded['message']??'MGM query failed.'),false,502);
    $result=$decoded['data']??[];
    if (is_array($result) && !isset($result['signature']) && isset($decoded['signature'])) $result['signature']=$decoded['signature'];
    return $result;
}
function mgm_request_balance($path, $data) {
    $cfg=secret_config(); $timestamp=(string)round(microtime(true)*1000); $nonce=random_nonce(8);
    // The balance endpoint is documented separately from order endpoints:
    // merchant_no and signature are top-level request fields (not nested in data).
    $body=json_encode_wire(['merchant_no'=>$cfg['merchant_no'],'signature'=>(string)$data]);
    list($raw,$error,$http)=curl_json(base_url().$path,$body,common_headers($timestamp,$nonce,$cfg['app_id']));
    if ($raw===false) throw new BridgeError('MGM balance request failed: '.$error,false,502);
    $decoded=json_decode($raw,true);
    if (!is_array($decoded) || $http>=400 || strtolower((string)($decoded['state']??''))!=='ok') {
        $message=is_array($decoded)?(string)($decoded['message']??$decoded['msg']??$decoded['error']??'MGM balance request was rejected.'):'Invalid MGM balance response.';
        throw new BridgeError($message,false,502);
    }
    $result=$decoded['data']??[];
    if (is_array($result) && !isset($result['signature']) && isset($decoded['signature'])) $result['signature']=$decoded['signature'];
    return $result;
}

try {
    $raw = file_get_contents('php://input');
    $hook = strtolower((string)($_GET['hook'] ?? ''));
    if ($hook === 'deposit' || $hook === 'withdrawal') handle_provider_callback($hook, $raw);

    if ($_SERVER['REQUEST_METHOD'] !== 'POST') throw new BridgeError('POST required.', true, 405);
    $secret = envv('APM_MGM_BRIDGE_SECRET');
    if ($secret === '') throw new BridgeError('Bridge secret is not configured.', true, 503);
    $timestamp = (string)($_SERVER['HTTP_X_APM_TIMESTAMP'] ?? '');
    $nonce = (string)($_SERVER['HTTP_X_APM_NONCE'] ?? '');
    $signature = strtolower((string)($_SERVER['HTTP_X_APM_SIGNATURE'] ?? ''));
    $tsMs = ctype_digit($timestamp) ? (int)$timestamp : 0;
    if (strlen($timestamp)!==13 || abs((int)round(microtime(true)*1000)-$tsMs)>300000
        || !preg_match('/^[A-Za-z0-9]{6,16}$/',$nonce)) throw new BridgeError('Invalid bridge timestamp or nonce.',true,401);
    $expected = hash_hmac('sha256', bridge_request_signature_message($timestamp,$nonce,$raw),$secret);
    if (!hash_equals($expected,$signature)) throw new BridgeError('Invalid bridge signature.',true,401);
    claim_nonce_once($nonce);
    $request=read_payload($raw);
    $action=(string)($request['action']??''); $payload=is_array($request['payload']??null)?$request['payload']:[];
    $result=perform_action($action,$payload);
    send_bridge_json(['ok'=>true,'data'=>$result],200);
} catch (Throwable $e) {
    $status=$e instanceof BridgeError?$e->httpStatus:500;
    $definite=$e instanceof BridgeError?$e->definite:false;
    send_bridge_json(['ok'=>false,'error'=>$e->getMessage(),'definite'=>$definite],$status);
}
