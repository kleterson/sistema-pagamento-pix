const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { MercadoPagoConfig, Payment } = require('mercadopago');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(cors());

// --- BANCO DE DADOS (SQLite) ---
const db = new sqlite3.Database('./vendas.db', (err) => {
  if (err) console.error('Erro ao abrir o banco:', err.message);
  else console.log('📁 Banco de dados SQLite conectado com sucesso!');
});

db.run(`
  CREATE TABLE IF NOT EXISTS pagamentos (
    id TEXT PRIMARY KEY,
    valor REAL,
    status TEXT,
    metodo TEXT,
    data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- MERCADO PAGO ---
const client = new MercadoPagoConfig({ 
  accessToken: 'APP_USR-517824253559090-073117-47dad5ef4352fb0abd9e5d717275dfa3-71867761' // <-- Lembre-se de manter seu Token aqui!
});
const payment = new Payment(client);

// WebSocket
io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
});

// 1. ROTA PIX
app.post('/api/pix/valor-fixo', async (req, res) => {
  try {
    const { valor } = req.body;
    const result = await payment.create({
      body: {
        transaction_amount: Number(valor),
        description: 'Pagamento Pix',
        payment_method_id: 'pix',
        payer: { email: 'cliente@email.com' }
      }
    });

    const paymentId = String(result.id);
    db.run(`INSERT INTO pagamentos (id, valor, status, metodo) VALUES (?, ?, ?, ?)`, [paymentId, valor, 'PENDENTE', 'PIX']);

    res.json({
      success: true,
      id: paymentId,
      copiaECola: result.point_of_interaction.transaction_data.qr_code,
      qrCodeBase64: result.point_of_interaction.transaction_data.qr_code_base64
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 2. NOVA ROTA: CARTÃO DE CRÉDITO/DÉBITO
app.post('/api/cartao/pagar', async (req, res) => {
  try {
    const { token, issuer_id, payment_method_id, transaction_amount, installments, email, cpf } = req.body;

    const paymentData = {
      transaction_amount: Number(transaction_amount),
      token: token,
      description: 'Pagamento via Cartão',
      installments: Number(installments),
      payment_method_id: payment_method_id,
      issuer_id: issuer_id,
      payer: {
        email: email,
        identification: {
          type: 'CPF',
          number: cpf
        }
      }
    };

    const result = await payment.create({ body: paymentData });
    const paymentId = String(result.id);
    const status = result.status === 'approved' ? 'APROVADO' : result.status.toUpperCase();

    // Salva no banco de dados
    db.run(`INSERT INTO pagamentos (id, valor, status, metodo) VALUES (?, ?, ?, ?)`, [paymentId, transaction_amount, status, 'CARTAO']);

    if (status === 'APROVADO') {
      io.emit('pagamento_confirmado', { id: paymentId, valor: transaction_amount });
    }

    res.json({ success: true, status: result.status, status_detail: result.status_detail });
  } catch (error) {
    console.error('Erro no pagamento do cartão:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// 3. WEBHOOK
app.post('/webhook', async (req, res) => {
  const { type, data } = req.body;
  if (type === 'payment') {
    try {
      const paymentData = await payment.get({ id: data.id });
      if (paymentData.status === 'approved') {
        const paymentId = String(data.id);
        const valor = paymentData.transaction_amount;
        db.run(`UPDATE pagamentos SET status = 'APROVADO' WHERE id = ?`, [paymentId]);
        io.emit('pagamento_confirmado', { id: paymentId, valor: valor });
      }
    } catch (err) {
      console.error('Erro no webhook:', err);
    }
  }
  res.sendStatus(200);
});

// 4. HISTÓRICO
app.get('/api/historico', (req, res) => {
  db.all(`SELECT * FROM pagamentos ORDER BY data_criacao DESC`, [], (err, rows) => {
    if (err) res.status(500).json({ success: false, error: err.message });
    else res.json({ success: true, pagamentos: rows });
  });
});

app.get('/api/pix/valor-livre', (req, res) => {
  res.json({ success: true, chavePix: "13996107399" });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});