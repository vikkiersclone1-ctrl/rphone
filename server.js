'use strict';

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

function loadLocalEnvironment() {
    const envFile = path.join(__dirname, '.env');
    if (!fsSync.existsSync(envFile)) {
        return;
    }

    const contents = fsSync.readFileSync(envFile, 'utf8');
    contents.split(/\r?\n/).forEach((line) => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match && process.env[match[1]] === undefined) {
            process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
        }
    });
}

loadLocalEnvironment();

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_COOKIE = 'rphone_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DATA_FILE = process.env.RPHONE_DATA_FILE || path.join(__dirname, 'data', 'orders.json');
const DATA_DIRECTORY = path.dirname(DATA_FILE);
const MAX_BODY_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimits = new Map();
const sessions = new Map();
let databaseWriteQueue = Promise.resolve();

const DEFAULT_PRICES = {
    biasa: { min: 150000, max: 250000 },
    sedang: { min: 250000, max: 450000 },
    bagus: { min: 450000, max: 800000 },
    terbaik: { min: 700000, max: 1500000 },
    services: {
        battery: { min: null, max: null },
        housing: { min: null, max: null },
        charging_port: { min: null, max: null },
        camera: { min: null, max: null },
        speaker_mic: { min: null, max: null },
        buttons: { min: null, max: null },
        software: { min: null, max: null },
        other: { min: null, max: null }
    },
    biayaJasa: 0
};

const OTHER_SERVICE_OPTIONS = {
    battery: 'Ganti baterai',
    housing: 'Ganti housing / casing',
    charging_port: 'Perbaikan konektor charger',
    camera: 'Perbaikan kamera',
    speaker_mic: 'Perbaikan speaker / mikrofon',
    buttons: 'Perbaikan tombol power / volume',
    software: 'Servis software',
    other: 'Servis lainnya'
};

const QUALITY_OPTIONS = {
    'TFT / High Copy (Biasa)': { key: 'biasa', label: 'TFT / High Copy' },
    'Incell (Menengah/Standard)': { key: 'sedang', label: 'Incell / Crown' },
    'OLED (Bagus)': { key: 'bagus', label: 'OLED / Hard OLED' },
    'Original 100% / Super AMOLED (Terbaik)': { key: 'terbaik', label: 'Original / OEM' },
    'Belum Tahu / Butuh Rekomendasi': null
};

const SERVICE_STATUSES = [
    'Formulir diterima',
    'Menunggu HP dikirim',
    'HP diterima',
    'Sedang dianalisis',
    'Menunggu persetujuan biaya',
    'Menunggu sparepart',
    'Sedang diperbaiki',
    'Selesai',
    'Siap diambil/dikirim',
    'Dibatalkan'
];

class HttpError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

function cloneDefaultPrices() {
    return JSON.parse(JSON.stringify(DEFAULT_PRICES));
}

function sendJson(response, statusCode, value, headers = {}) {
    response.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
        ...headers
    });
    response.end(JSON.stringify(value));
}

function validatePrices(prices) {
    if (!prices || typeof prices !== 'object') {
        throw new HttpError(400, 'Daftar harga tidak valid.');
    }

    for (const key of ['biasa', 'sedang', 'bagus', 'terbaik']) {
        const price = prices[key];
        if (!price ||
            !Number.isSafeInteger(price.min) ||
            !Number.isSafeInteger(price.max) ||
            price.min < 0 ||
            price.max < price.min) {
            throw new HttpError(400, `Kisaran harga ${key} tidak valid.`);
        }
    }

    if (!Number.isSafeInteger(prices.biayaJasa) || prices.biayaJasa < 0) {
        throw new HttpError(400, 'Biaya jasa harus berupa angka nol atau lebih.');
    }
    const servicePrices = prices.services || DEFAULT_PRICES.services;
    for (const [key, defaultPrice] of Object.entries(DEFAULT_PRICES.services)) {
        const servicePrice = servicePrices[key] || defaultPrice;
        const hasMinimum = Number.isSafeInteger(servicePrice.min) && servicePrice.min >= 0;
        const hasMaximum = Number.isSafeInteger(servicePrice.max) && servicePrice.max >= 0;
        if ((servicePrice.min === null && servicePrice.max === null) ||
            (hasMinimum && hasMaximum && servicePrice.max >= servicePrice.min)) {
            continue;
        }
        throw new HttpError(400, `Kisaran harga servis ${key} tidak valid. Isi kedua harga atau kosongkan keduanya.`);
    }

    for (const key of ['biasa', 'sedang', 'bagus', 'terbaik']) {
        if (!Number.isSafeInteger(prices[key].max + prices.biayaJasa)) {
            throw new HttpError(400, `Total harga ${key} melebihi batas angka yang didukung.`);
        }
    }
    for (const [key, servicePrice] of Object.entries(servicePrices)) {
        if (servicePrice && Number.isSafeInteger(servicePrice.max) &&
            !Number.isSafeInteger(servicePrice.max + prices.biayaJasa)) {
            throw new HttpError(400, `Total harga servis ${key} melebihi batas angka yang didukung.`);
        }
    }

    return {
        biasa: { min: prices.biasa.min, max: prices.biasa.max },
        sedang: { min: prices.sedang.min, max: prices.sedang.max },
        bagus: { min: prices.bagus.min, max: prices.bagus.max },
        terbaik: { min: prices.terbaik.min, max: prices.terbaik.max },
        services: Object.fromEntries(
            Object.keys(DEFAULT_PRICES.services).map((key) => {
                const servicePrice = servicePrices[key] || DEFAULT_PRICES.services[key];
                return [key, { min: servicePrice.min, max: servicePrice.max }];
            })
        ),
        biayaJasa: prices.biayaJasa
    };
}

async function readDatabase() {
    let contents;
    try {
        contents = await fs.readFile(DATA_FILE, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') {
            return { orders: [], prices: cloneDefaultPrices() };
        }
        throw error;
    }

    let database;
    try {
        database = JSON.parse(contents.replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`Data order tidak dapat dibaca: ${error.message}`);
    }

    if (!database || !Array.isArray(database.orders)) {
        throw new Error('Struktur data order tidak valid.');
    }

    return {
        orders: database.orders,
        prices: validatePrices(database.prices)
    };
}

async function getDatabase() {
    await databaseWriteQueue;
    return readDatabase();
}

async function saveDatabase(database) {
    await fs.mkdir(DATA_DIRECTORY, { recursive: true });
    const temporaryFile = path.join(
        DATA_DIRECTORY,
        `orders-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`
    );
    try {
        await fs.writeFile(temporaryFile, JSON.stringify(database, null, 2), { encoding: 'utf8', mode: 0o600 });
        await fs.rename(temporaryFile, DATA_FILE);
    } catch (error) {
        await fs.rm(temporaryFile, { force: true });
        throw error;
    }
}

function updateDatabase(update) {
    const operation = databaseWriteQueue.then(async () => {
        const database = await readDatabase();
        const result = await update(database);
        await saveDatabase(database);
        return result;
    });
    databaseWriteQueue = operation.catch(() => {});
    return operation;
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let length = 0;
        let tooLarge = false;

        request.on('data', (chunk) => {
            length += chunk.length;
            if (length > MAX_BODY_BYTES) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) {
                chunks.push(chunk);
            }
        });
        request.on('end', () => {
            if (tooLarge) {
                reject(new HttpError(413, 'Ukuran data terlalu besar.'));
                return;
            }
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!body || typeof body !== 'object' || Array.isArray(body)) {
                    throw new Error('Body harus berupa objek JSON.');
                }
                resolve(body);
            } catch (error) {
                reject(new HttpError(400, 'Format data tidak valid.'));
            }
        });
        request.on('error', reject);
    });
}

function requireText(value, label, maxLength, required = true) {
    if (typeof value !== 'string') {
        if (!required && (value === undefined || value === null)) {
            return '';
        }
        throw new HttpError(400, `${label} tidak valid.`);
    }

    const text = value.trim();
    if ((required && text.length === 0) || text.length > maxLength) {
        throw new HttpError(400, `${label} wajib diisi dan maksimal ${maxLength} karakter.`);
    }
    return text;
}

function normalizePhone(phone) {
    let digits = phone.replace(/\D/g, '');
    if (digits.startsWith('0')) {
        digits = `62${digits.slice(1)}`;
    }
    return digits;
}

function consumeRateLimit(request, route, maximum, windowMs) {
    const key = `${route}:${request.socket.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const current = rateLimits.get(key);
    if (!current || now - current.startedAt >= windowMs) {
        rateLimits.set(key, { startedAt: now, count: 1 });
        return;
    }
    if (current.count >= maximum) {
        throw new HttpError(429, 'Terlalu banyak percobaan. Silakan coba lagi beberapa menit.');
    }
    current.count += 1;
}

function timingSafePasswordMatch(candidate) {
    if (typeof candidate !== 'string') {
        return false;
    }
    const expectedBuffer = Buffer.from(ADMIN_PASSWORD);
    const candidateBuffer = Buffer.from(candidate);
    return expectedBuffer.length === candidateBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

function getSessionToken(request) {
    const cookieHeader = request.headers.cookie || '';
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]+)`));
    return match ? match[1] : '';
}

function requireAdmin(request) {
    const token = getSessionToken(request);
    const expiresAt = sessions.get(token);
    if (!expiresAt || expiresAt <= Date.now()) {
        sessions.delete(token);
        throw new HttpError(401, 'Sesi admin berakhir. Silakan masuk kembali.');
    }
    sessions.set(token, Date.now() + SESSION_TTL_MS);
}

function safeOrderForCustomer(order) {
    return {
        id: order.id,
        createdAt: order.createdAt,
        device: order.device,
        serviceType: order.serviceType || 'lcd',
        serviceLabel: order.serviceLabel || 'Ganti LCD / layar',
        otherService: order.otherService || '',
        lcdQuality: order.lcdQuality,
        brand: order.brand,
        status: order.status,
        history: order.history
    };
}

function buildOrder(body, prices) {
    const name = requireText(body.name, 'Nama', 100);
    const phone = requireText(body.phone, 'Nomor WhatsApp', 32);
    const normalizedPhone = normalizePhone(phone);
    if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
        throw new HttpError(400, 'Nomor WhatsApp harus berisi 8 sampai 15 digit.');
    }

    const device = requireText(body.device, 'Tipe HP', 100);
    const serviceType = body.serviceType || 'lcd';
    const isLcdService = serviceType === 'lcd';
    if (!isLcdService && !Object.prototype.hasOwnProperty.call(OTHER_SERVICE_OPTIONS, serviceType)) {
        throw new HttpError(400, 'Jenis servis tidak dikenal.');
    }
    const lcdQuality = isLcdService
        ? requireText(body.lcdQuality, 'Pilihan kualitas LCD', 80)
        : 'Tidak berlaku';
    if (isLcdService && !Object.prototype.hasOwnProperty.call(QUALITY_OPTIONS, lcdQuality)) {
        throw new HttpError(400, 'Pilihan kualitas LCD tidak dikenal.');
    }
    const serviceLabel = isLcdService
        ? 'Ganti LCD / layar'
        : OTHER_SERVICE_OPTIONS[serviceType];
    const otherService = serviceType === 'other'
        ? requireText(body.otherService, 'Detail servis lainnya', 100)
        : '';
    const brand = requireText(body.brand, 'Merk sparepart', 100, false) || 'Bebas / Rekomendasi Teknisi';
    const issue = requireText(body.issue, 'Detail kerusakan', 1000, false);
    let price;

    if (isLcdService && QUALITY_OPTIONS[lcdQuality]) {
        const selectedQuality = QUALITY_OPTIONS[lcdQuality];
        const lcdPrice = prices[selectedQuality.key];
        price = {
            label: selectedQuality.label,
            itemMin: lcdPrice.min,
            itemMax: lcdPrice.max,
            serviceFee: prices.biayaJasa,
            totalMin: lcdPrice.min + prices.biayaJasa,
            totalMax: lcdPrice.max + prices.biayaJasa
        };
    } else {
        const servicePrice = isLcdService ? null : prices.services[serviceType];
        const hasServicePrice = servicePrice && servicePrice.min !== null && servicePrice.max !== null;
        price = {
            label: hasServicePrice ? serviceLabel : 'Menunggu pengecekan',
            itemMin: hasServicePrice ? servicePrice.min : null,
            itemMax: hasServicePrice ? servicePrice.max : null,
            serviceFee: prices.biayaJasa,
            totalMin: hasServicePrice ? servicePrice.min + prices.biayaJasa : null,
            totalMax: hasServicePrice ? servicePrice.max + prices.biayaJasa : null
        };
    }

    const createdAt = new Date().toISOString();
    const id = `RP-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const status = 'Formulir diterima';
    return {
        id,
        createdAt,
        name,
        phone,
        normalizedPhone,
        device,
        serviceType,
        serviceLabel,
        otherService,
        lcdQuality,
        brand,
        issue,
        price,
        status,
        history: [{ at: createdAt, status, note: 'Formulir berhasil diterima.' }]
    };
}

function validatePriceUpdate(body) {
    return validatePrices(body);
}

async function handleApi(request, response, url) {
    const pathname = url.pathname;
    const method = request.method;

    if (method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true });
    }

    if (method === 'GET' && pathname === '/api/public-config') {
        const database = await getDatabase();
        return sendJson(response, 200, { prices: database.prices });
    }

    if (method === 'POST' && pathname === '/api/orders') {
        const body = await readJsonBody(request);
        const order = await updateDatabase((database) => {
            const createdOrder = buildOrder(body, database.prices);
            database.orders.push(createdOrder);
            return createdOrder;
        });
        return sendJson(response, 201, { order });
    }

    if (method === 'POST' && pathname === '/api/tracking') {
        consumeRateLimit(request, 'tracking', 20, RATE_LIMIT_WINDOW_MS);
        const body = await readJsonBody(request);
        const query = requireText(body.query, 'Nama atau nomor WhatsApp', 100);
        const looksLikePhone = /^[+\d\s().-]+$/.test(query);
        let orders;

        if (looksLikePhone) {
            const phone = normalizePhone(query);
            if (phone.length < 8 || phone.length > 15) {
                throw new HttpError(400, 'Masukkan nomor WhatsApp lengkap yang digunakan pada formulir.');
            }
            const database = await getDatabase();
            orders = database.orders
                .filter((order) => order.normalizedPhone === phone)
                .map(safeOrderForCustomer);
        } else {
            if (query.length < 2) {
                throw new HttpError(400, 'Masukkan nama lengkap yang digunakan pada formulir.');
            }
            const normalizedName = query.toLocaleLowerCase('id-ID');
            const database = await getDatabase();
            orders = database.orders
                .filter((order) => order.name.toLocaleLowerCase('id-ID') === normalizedName)
                .map(safeOrderForCustomer);
        }

        return sendJson(response, 200, { orders });
    }

    if (method === 'POST' && pathname === '/api/admin/login') {
        consumeRateLimit(request, 'admin-login', 8, 15 * 60 * 1000);
        const body = await readJsonBody(request);
        if (!timingSafePasswordMatch(body.password)) {
            throw new HttpError(401, 'Password admin salah.');
        }
        const token = crypto.randomBytes(32).toString('hex');
        sessions.set(token, Date.now() + SESSION_TTL_MS);
        for (const [sessionToken, expiresAt] of sessions.entries()) {
            if (expiresAt <= Date.now()) {
                sessions.delete(sessionToken);
            }
        }
        const secureCookie = process.env.NODE_ENV === 'production' ? '; Secure' : '';
        return sendJson(response, 200, { authenticated: true }, {
            'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secureCookie}`
        });
    }

    if (method === 'GET' && pathname === '/api/admin/session') {
        try {
            requireAdmin(request);
            return sendJson(response, 200, { authenticated: true });
        } catch (error) {
            if (error instanceof HttpError && error.statusCode === 401) {
                return sendJson(response, 200, { authenticated: false });
            }
            throw error;
        }
    }

    if (method === 'POST' && pathname === '/api/admin/logout') {
        const token = getSessionToken(request);
        sessions.delete(token);
        return sendJson(response, 200, { authenticated: false }, {
            'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`
        });
    }

    if (pathname.startsWith('/api/admin/')) {
        requireAdmin(request);

        if (method === 'GET' && pathname === '/api/admin/orders') {
            const database = await getDatabase();
            const orders = database.orders
                .slice()
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
            return sendJson(response, 200, { orders });
        }

        if (method === 'GET' && pathname === '/api/admin/prices') {
            const database = await getDatabase();
            return sendJson(response, 200, { prices: database.prices });
        }

        if (method === 'PUT' && pathname === '/api/admin/prices') {
            const body = await readJsonBody(request);
            const prices = validatePriceUpdate(body);
            await updateDatabase((database) => {
                database.prices = prices;
            });
            return sendJson(response, 200, { prices });
        }

        const orderMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (method === 'PATCH' && orderMatch) {
            const orderId = decodeURIComponent(orderMatch[1]);
            const body = await readJsonBody(request);
            const status = requireText(body.status, 'Status', 80);
            if (!SERVICE_STATUSES.includes(status)) {
                throw new HttpError(400, 'Status servis tidak dikenal.');
            }
            const note = requireText(body.note, 'Catatan progres', 300, false);
            const updatedOrder = await updateDatabase((database) => {
                const order = database.orders.find((item) => item.id === orderId);
                if (!order) {
                    throw new HttpError(404, 'Order tidak ditemukan.');
                }
                order.status = status;
                order.history.push({
                    at: new Date().toISOString(),
                    status,
                    note
                });
                return order;
            });
            return sendJson(response, 200, { order: updatedOrder });
        }
    }

    throw new HttpError(404, 'Endpoint tidak ditemukan.');
}

const STATIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
    '/logo.png': ['logo.png', 'image/png'],
    '/hero-service.jpg': ['hero-service.jpg', 'image/jpeg'],
    '/hero-background.jpg': ['hero-background.jpg', 'image/jpeg']
};

async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

    if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, 'Metode HTTP tidak diizinkan.');
    }

    const staticFile = STATIC_FILES[url.pathname];
    if (!staticFile) {
        throw new HttpError(404, 'Halaman tidak ditemukan.');
    }

    const filePath = path.join(__dirname, staticFile[0]);
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
        'Content-Type': staticFile[1],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    response.end(request.method === 'HEAD' ? undefined : contents);
}

if (!ADMIN_PASSWORD) {
    console.error('ADMIN_PASSWORD belum diatur. Atur variabel lingkungan sebelum menjalankan server.');
    process.exit(1);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error('PORT harus berupa angka antara 1 dan 65535.');
    process.exit(1);
}

const server = http.createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
        if (response.headersSent || response.destroyed) {
            console.error('Permintaan gagal setelah respons dimulai:', error);
            return;
        }
        if (error instanceof HttpError) {
            sendJson(response, error.statusCode, { error: error.message });
            return;
        }
        console.error('Permintaan gagal:', error);
        sendJson(response, 500, { error: 'Terjadi kesalahan server. Coba kembali nanti.' });
    });
});

server.listen(PORT, HOST, () => {
    console.log(`RPhone berjalan di http://${HOST}:${PORT}`);
    console.log(`Data order disimpan di ${DATA_FILE}`);
});
