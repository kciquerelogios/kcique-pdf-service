const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

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

async function loginHandler(req, res) {
  const { secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const b = await getBrowser();
    if (loginPage) { try { await loginPage.close(); } catch(e) {} }
    loginPage = await b.newPage();
    await loginPage.setViewport({ width: 1280, height: 800 });

    // Interceptar reCAPTCHA antes de carregar a página
    await loginPage.evaluateOnNewDocument(() => {
      // Mockar o grecaptcha para retornar token fake
      window.grecaptcha = {
        ready: (cb) => cb(),
        execute: () => Promise.resolve('fake-recaptcha-token'),
        render: () => 0,
        getResponse: () => 'fake-recaptcha-token'
      };
      window.isRecaptchaEnabled = false;
    });

    // Aguardar Vue renderizar os inputs
    await loginPage.goto('https://melhorenvio.com.br/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    // Aguardar input aparecer com polling (Vue carrega async)
    let emailInput = null, passInput = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(r => setTimeout(r, 1000));
      const inputs = await loginPage.$$('input');
      for (const input of inputs) {
        const type = await input.evaluate(el => el.type).catch(()=>'');
        const placeholder = await input.evaluate(el => el.placeholder || '').catch(()=>'');
        const visible = await input.evaluate(el => el.offsetParent !== null).catch(()=>false);
        console.log('Input attempt', attempt, ':', type, placeholder, 'visible:', visible);
        if (visible && (type === 'email' || name === 'username' || name === 'email' || type === 'text')) emailInput = input;
        if (visible && type === 'password') passInput = input;
      }
      if (emailInput && passInput) break;
    }

    if (!emailInput || !passInput) {
      const html = await loginPage.content();
      return res.json({ status: 'error', message: 'Inputs nao encontrados apos 20s', inputs_found: (await loginPage.$$('input')).length });
    }

    await emailInput.click({ clickCount: 3 });
    await emailInput.type(ME_EMAIL, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));
    await passInput.click({ clickCount: 3 });
    await passInput.type(ME_SENHA, { delay: 80 });
    await new Promise(r => setTimeout(r, 1000));

    // Tentar clicar no botão de submit
    const submitBtn = await loginPage.$('button[type="submit"], button.btn-login, input[type="submit"]');
    console.log('Submit button found:', !!submitBtn);
    
    if (submitBtn) {
      await Promise.all([
        submitBtn.click(),
        loginPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{})
      ]);
    } else {
      await Promise.all([
        loginPage.keyboard.press('Enter'),
        loginPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{})
      ]);
    }

    await new Promise(r => setTimeout(r, 5000));
    const url = loginPage.url();
    const html = await loginPage.content();
    console.log('Login URL:', url);
    console.log('HTML snippet:', html.substring(5000, 5500));

    if (html.includes('código') || html.includes('code') || html.includes('acesso seguro') || html.includes('verificação') || url.includes('two-factor') || url.includes('verify') || url.includes('security')) {
      return res.json({ status: 'needs_2fa', message: 'Envie o codigo via /verify-code?secret=...&code=XXXXXX' });
    }
    if (!url.includes('/login')) {
      await saveCookies(loginPage);
      await loginPage.close();
      loginPage = null;
      return res.json({ status: 'logged_in', message: 'Login realizado com sucesso!' });
    }
    return res.json({ status: 'failed', message: 'Login falhou', url });
  } catch(e) {
    console.error('Login error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

async function verifyHandler(req, res) {
  const { secret, code } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!code) return res.status(400).json({ error: 'code required' });
  if (!loginPage) return res.status(400).json({ error: 'Nenhum login em andamento. Chame /login primeiro.' });
  try {
    await loginPage.waitForSelector('input', { timeout: 5000 }).catch(()=>{});
    const inputs = await loginPage.$$('input[type="text"], input[type="number"], input[type="tel"]');
    console.log('Inputs para codigo:', inputs.length);
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
    if (!url.includes('/login') && !url.includes('two-factor') && !url.includes('verify') && !url.includes('security')) {
      await saveCookies(loginPage);
      await loginPage.close();
      loginPage = null;
      return res.json({ status: 'logged_in', message: 'Login com 2FA realizado! Cookies salvos.' });
    }
    return res.json({ status: 'failed', url });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}

app.get('/login', loginHandler);
app.post('/login', loginHandler);
app.get('/verify-code', verifyHandler);
app.post('/verify-code', verifyHandler);

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
    if (!loggedIn) {
      await page.close();
      return res.status(401).json({ error: 'not_logged_in', message: 'Faca login primeiro via /login' });
    }
    await page.goto(`https://melhorenvio.com.br/imprimir/${orderId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
    await saveCookies(page);
    await page.close();
    console.log('PDF gerado:', pdfBuffer.length, 'bytes');
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `attachment; filename="etiqueta-${orderId}.pdf"`);
    res.send(pdfBuffer);
  } catch(e) {
    if (page) await page.close().catch(()=>{});
    res.status(500).json({ error: e.message });
  }
});

// Debug: ver HTML da página atual do loginPage
app.get('/debug', async (req, res) => {
  const { secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!loginPage) return res.json({ error: 'Nenhuma pagina de login ativa' });
  try {
    const url = loginPage.url();
    const html = await loginPage.content();
    const inputs = await loginPage.$$('input');
    const inputInfos = [];
    for (const inp of inputs) {
      inputInfos.push({
        type: await inp.evaluate(el => el.type).catch(()=>''),
        name: await inp.evaluate(el => el.name).catch(()=>''),
        placeholder: await inp.evaluate(el => el.placeholder).catch(()=>''),
        visible: await inp.evaluate(el => el.offsetParent !== null).catch(()=>false)
      });
    }
    res.json({ url, inputs: inputInfos, html_snippet: html.substring(5000, 7000) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Endpoint para injetar cookies manualmente
app.post('/set-cookies', async (req, res) => {
  const { secret } = req.query;
  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { cookies } = req.body;
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies));
    console.log('Cookies injetados:', cookies.length);
    res.json({ ok: true, count: cookies.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({ ok: true, loggedIn: fs.existsSync(COOKIES_FILE), ts: new Date().toISOString() }));

app.listen(PORT, () => console.log('PDF service rodando na porta', PORT));
