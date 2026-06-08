const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SECRET = process.env.PDF_SECRET || 'kcique2026';
const ME_EMAIL = process.env.MELHORENVIO_EMAIL || '';
const ME_SENHA = process.env.MELHORENVIO_SENHA || '';
const COOKIES_FILE = '/tmp/me_cookies.json';

let browser = null;
let loginPage = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-first-run','--no-zygote','--single-process']
    });
  }
  return browser;
}

async function loadCookies(page) {
  try {
    if (fs.existsSync(COOKIES_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      await page.setCookie(...cookies);
      return true;
    }
  } catch(e) {}
  return false;
}

async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies));
    console.log('Cookies salvos:', cookies.length);
  } catch(e) {}
}

async function isLoggedIn(page) {
  try {
    await page.goto('https://melhorenvio.com.br/painel', { waitUntil: 'networkidle2', timeout: 15000 });
    return !page.url().includes('/login');
  } catch(e) { return false; }
}

// Login handler
async function loginHandler(req, res) {
  const { secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const b = await getBrowser();
    if (loginPage) { try { await loginPage.close(); } catch(e) {} }
    loginPage = await b.newPage();
    await loginPage.setViewport({ width: 1280, height: 800 });
    await loginPage.goto('https://melhorenvio.com.br/login', { waitUntil: 'networkidle2', timeout: 15000 });
    await loginPage.type('input[name="email"]', ME_EMAIL, { delay: 50 });
    await loginPage.type('input[name="password"]', ME_SENHA, { delay: 50 });
    await Promise.all([
      loginPage.click('button[type="submit"]'),
      loginPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
    ]);
    const url = loginPage.url();
    const html = await loginPage.content();
    console.log('Login URL:', url);
    if (html.includes('código') || html.includes('code') || url.includes('two-factor') || url.includes('verify')) {
      return res.json({ status: 'needs_2fa', message: 'Verifique seu email e envie o código via /verify-code?secret=...&code=XXXXXX' });
    }
    if (!url.includes('/login')) {
      await saveCookies(loginPage);
      await loginPage.close();
      loginPage = null;
      return res.json({ status: 'logged_in', message: 'Login realizado com sucesso!' });
    }
    return res.json({ status: 'failed', message: 'Login falhou', url });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

// Verify code handler
async function verifyHandler(req, res) {
  const { secret, code } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!loginPage) return res.status(400).json({ error: 'Nenhum login em andamento. Chame /login primeiro.' });
  try {
    const inputs = await loginPage.$$('input[type="text"], input[type="number"], input[name="code"], input[name="token"]');
    console.log('Inputs encontrados:', inputs.length);
    if (inputs.length > 0) {
      await inputs[0].click({ clickCount: 3 });
      await inputs[0].type(code, { delay: 100 });
    } else {
      await loginPage.keyboard.type(code);
    }
    await Promise.all([
      loginPage.keyboard.press('Enter'),
      loginPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{})
    ]);
    await new Promise(r => setTimeout(r, 2000));
    const url = loginPage.url();
    console.log('Apos codigo URL:', url);
    if (!url.includes('/login') && !url.includes('two-factor') && !url.includes('verify')) {
      await saveCookies(loginPage);
      await loginPage.close();
      loginPage = null;
      return res.json({ status: 'logged_in', message: 'Login com 2FA realizado! Cookies salvos.' });
    }
    return res.json({ status: 'failed', url, message: 'Codigo invalido ou ainda na pagina de verificacao' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

app.get('/login', loginHandler);
app.post('/login', loginHandler);
app.get('/verify-code', verifyHandler);
app.post('/verify-code', verifyHandler);

// Gerar PDF
app.get('/pdf/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await loadCookies(page);
    const loggedIn = await isLoggedIn(page);
    console.log('Logged in:', loggedIn);
    if (!loggedIn) {
      await page.close();
      return res.status(401).json({ error: 'not_logged_in', message: 'Faca login primeiro via /login' });
    }
    const printUrl = `https://melhorenvio.com.br/imprimir/${orderId}`;
    console.log('Acessando:', printUrl);
    await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await saveCookies(page);
    await page.close();
    console.log('PDF gerado:', pdfBuffer.length, 'bytes');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="etiqueta-${orderId}.pdf"`);
    res.send(pdfBuffer);
  } catch(e) {
    console.error('Erro:', e.message);
    if (page) await page.close().catch(()=>{});
    res.status(500).json({ error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, loggedIn: fs.existsSync(COOKIES_FILE), ts: new Date().toISOString() }));

app.listen(PORT, () => console.log('PDF service rodando na porta', PORT));
