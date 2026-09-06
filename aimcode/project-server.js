const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TRACKING_FLOW = ['Order placed', 'Payment confirmed', 'Processing', 'Packed', 'Out for delivery', 'Delivered'];

function rowToProduct(row) {
  return {
    id: row.id,
    name: row.name,
    cat: row.category,
    icon: row.icon,
    price: row.price,
    was: row.was_price,
    rating: row.rating,
    desc: row.description,
    sizes: JSON.parse(row.sizes),
    colors: JSON.parse(row.colors),
    stock: JSON.parse(row.stock),
  };
}

// ---------- products ----------

// GET /api/products?search=&category=
app.get('/api/products', (req, res) => {
  const { search, category } = req.query;
  let rows = db.prepare('SELECT * FROM products').all();
  let products = rows.map(rowToProduct);

  if (category) products = products.filter(p => p.cat.toLowerCase() === category.toLowerCase());
  if (search) products = products.filter(p => p.name.toLowerCase().includes(search.toLowerCase()));

  res.json(products);
});

app.get('/api/products/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Product not found' });
  res.json(rowToProduct(row));
});

// ---------- orders ----------

// POST /api/orders
// body: { fullName, email, phone, state, city, address, deliveryOption: {name, fee},
//         items: [{ productId, name, size, color, price, qty }] }
app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const required = ['fullName', 'email', 'phone', 'state', 'city', 'address', 'deliveryOption', 'items'];
  for (const field of required) {
    if (!body[field]) return res.status(400).json({ error: `Missing field: ${field}` });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return res.status(400).json({ error: 'Order must include at least one item' });
  }

  // Validate stock for every line before touching the database.
  const productRows = {};
  for (const item of body.items) {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(item.productId);
    if (!row) return res.status(400).json({ error: `Unknown product: ${item.productId}` });
    const stock = JSON.parse(row.stock);
    const available = stock[item.size] ?? 0;
    if (item.qty > available) {
      return res.status(409).json({ error: `Not enough stock for ${row.name} (size ${item.size}): ${available} left` });
    }
    productRows[item.productId] = row;
  }

  const subtotal = body.items.reduce((sum, it) => sum + it.price * it.qty, 0);
  const deliveryFee = Number(body.deliveryOption.fee) || 0;
  const total = subtotal + deliveryFee;
  const orderNumber = `AAT-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;

  const createOrder = db.transaction(() => {
    const orderInsert = db.prepare(`
      INSERT INTO orders (order_number, full_name, email, phone, state, city, address, delivery_option, delivery_fee, subtotal, total, status)
      VALUES (@orderNumber, @fullName, @email, @phone, @state, @city, @address, @deliveryOption, @deliveryFee, @subtotal, @total, 'Processing')
    `);
    const info = orderInsert.run({
      orderNumber,
      fullName: body.fullName,
      email: body.email,
      phone: body.phone,
      state: body.state,
      city: body.city,
      address: body.address,
      deliveryOption: body.deliveryOption.name,
      deliveryFee,
      subtotal,
      total,
    });
    const orderId = info.lastInsertRowid;

    const itemInsert = db.prepare(`
      INSERT INTO order_items (order_id, product_id, name, size, color, price, qty)
      VALUES (@orderId, @productId, @name, @size, @color, @price, @qty)
    `);
    const stockUpdate = db.prepare('UPDATE products SET stock = ? WHERE id = ?');

    for (const item of body.items) {
      itemInsert.run({ orderId, ...item });

      // decrement stock
      const row = productRows[item.productId];
      const stock = JSON.parse(row.stock);
      stock[item.size] = Math.max(0, (stock[item.size] ?? 0) - item.qty);
      stockUpdate.run(JSON.stringify(stock), item.productId);
    }

    const eventInsert = db.prepare(`
      INSERT INTO tracking_events (order_id, status, message) VALUES (?, ?, ?)
    `);
    eventInsert.run(orderId, 'Order placed', 'Order received.');
    eventInsert.run(orderId, 'Payment confirmed', 'Payment simulated successfully (no live payment provider connected).');
    eventInsert.run(orderId, 'Processing', 'Order is being prepared.');

    return orderId;
  });

  const orderId = createOrder();
  res.status(201).json(getOrderResponse(orderId));
});

// GET /api/orders/:orderNumber  — used by a tracking page
app.get('/api/orders/:orderNumber', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(req.params.orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json(getOrderResponse(order.id));
});

// POST /api/orders/:orderNumber/advance — moves the order to the next status (admin-style helper)
app.post('/api/orders/:orderNumber/advance', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(req.params.orderNumber);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const currentIndex = TRACKING_FLOW.indexOf(order.status);
  const nextStatus = TRACKING_FLOW[currentIndex + 1];
  if (!nextStatus) return res.status(400).json({ error: 'Order is already at its final status' });

  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(nextStatus, order.id);
  db.prepare('INSERT INTO tracking_events (order_id, status, message) VALUES (?, ?, ?)')
    .run(order.id, nextStatus, `Status updated to ${nextStatus}.`);

  res.json(getOrderResponse(order.id));
});

function getOrderResponse(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  const items = db.prepare('SELECT product_id AS productId, name, size, color, price, qty FROM order_items WHERE order_id = ?').all(orderId);
  const events = db.prepare('SELECT status, message, created_at AS createdAt FROM tracking_events WHERE order_id = ? ORDER BY id ASC').all(orderId);

  const doneStatuses = new Set(events.map(e => e.status));
  const tracker = TRACKING_FLOW.map(status => ({
    label: status,
    done: doneStatuses.has(status),
    current: status === order.status,
    at: (events.find(e => e.status === status) || {}).createdAt || null,
  }));

  return {
    orderNumber: order.order_number,
    status: order.status,
    fullName: order.full_name,
    email: order.email,
    phone: order.phone,
    address: `${order.address}, ${order.city}, ${order.state}`,
    deliveryOption: order.delivery_option,
    deliveryFee: order.delivery_fee,
    subtotal: order.subtotal,
    total: order.total,
    createdAt: order.created_at,
    items,
    tracker,
  };
}

app.listen(PORT, () => {
  console.log(`Adure server running at http://localhost:${PORT}`);
});