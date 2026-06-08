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

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process'
      ]
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
  } catch(e) {}
}

async function isLoggedIn(page) {
  try {
    await page.goto('https://melhorenvio.com.br/painel', { waitUntil: 'networkidle2', timeout: 15000 });
    const url = page.url();
    return !url.includes('/login');
  } catch(e) { return false; }
}

async function doLogin(page) {
  await page.goto('https://melhorenvio.com.br/login', { waitUntil: 'networkidle2', timeout: 15000 });
  await page.type('input[name="email"]', ME_EMAIL, { delay: 50 });
  await page.type('input[name="password"]', ME_SENHA, { delay: 50 });
  await Promise.all([
    page.click('button[type="submit"]'),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
  ]);
  const url = page.url();
  console.log('Login URL:', url);
  return !url.includes('/login');
}

// Endpoint principal - gerar PDF
app.get('/pdf/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const { secret } = req.query;

  if (secret !== SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Carregar cookies salvos
    await loadCookies(page);

    // Verificar se está logado
    let loggedIn = await isLoggedIn(page);
    console.log('Logged in:', loggedIn);

    if (!loggedIn) {
      loggedIn = await doLogin(page);
      if (!loggedIn) {
        // Verificar se pediu aprovação por email
        const html = await page.content();
        if (html.includes('verificação') || html.includes('aprovação') || html.includes('email')) {
          await page.close();
          return res.status(202).json({ 
            error: 'approval_required', 
            message: 'Aprovação por email necessária. Verifique seu email e aprove o acesso, depois tente novamente.' 
          });
        }
        await page.close();
        return res.status(401).json({ error: 'Login falhou' });
      }
      await saveCookies(page);
    }

    // Acessar link de impressão
    const printUrl = `https://melhorenvio.com.br/imprimir/${orderId}`;
    console.log('Acessando:', printUrl);
    await page.goto(printUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Aguardar carregamento
    await new Promise(r => setTimeout(r, 2000));

    // Gerar PDF
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' }
    });

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

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.listen(PORT, () => console.log('PDF service rodando na porta', PORT));
