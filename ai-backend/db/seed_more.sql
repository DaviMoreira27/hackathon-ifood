SELECT setseed(0.42);

-- 25 usuários extras
INSERT INTO users (name, email, ifood_token, token_expires_at)
SELECT
  (ARRAY['Carlos','Fernanda','Rafael','Juliana','Bruno','Camila','Diego','Patrícia','Thiago','Beatriz',
         'Gustavo','Larissa','Felipe','Amanda','Rodrigo'])[1 + (g % 15)]
    || ' ' ||
  (ARRAY['Almeida','Souza','Pereira','Lima','Ferreira','Ribeiro','Carvalho','Gomes','Martins','Rocha'])[1 + (g % 10)],
  'user' || g || '@example.com',
  CASE WHEN g % 6 = 0 THEN NULL ELSE 'tok_mock_' || lpad(g::text, 4, '0') END,
  CASE WHEN g % 6 = 0 THEN NULL ELSE now() + ((g % 14) - 4) * interval '1 day' END
FROM generate_series(1, 25) g;

-- 80 pedidos distribuídos entre todos os usuários
INSERT INTO orders (owner_user_id, status, created_at)
SELECT
  1 + floor(random() * (SELECT count(*) FROM users))::int,
  (ARRAY['collecting','confirmed','paying','paid','paid','paid'])[1 + floor(random() * 6)::int]::order_status,
  now() - random() * interval '30 days'
FROM generate_series(1, 80);

-- 1 a 4 carts por pedido; total = subtotal + taxa de entrega
WITH base AS (
  SELECT o.id AS order_id, o.status AS ostatus, c,
         round((15 + random() * 85)::numeric, 2) AS subtotal
  FROM orders o
  CROSS JOIN LATERAL generate_series(1, 1 + (o.id % 4)) c
  WHERE o.id > 6
)
INSERT INTO carts (order_id, ifood_cart_id, subtotal, total, status)
SELECT
  order_id,
  'cart_ifood_' || order_id || '_' || c,
  subtotal,
  subtotal + round((3 + random() * 9)::numeric, 2),
  CASE ostatus
    WHEN 'paid'       THEN 'paid'
    WHEN 'collecting' THEN 'pending'
    WHEN 'confirmed'  THEN 'confirmed'
    ELSE (ARRAY['confirmed','paid'])[1 + floor(random() * 2)::int]
  END::cart_status
FROM base;

-- ~12 mensagens por usuário (conversas user/assistant/tool)
INSERT INTO messages (chat_id, user_id, role, content, created_at)
SELECT
  5000 + u.id,
  u.id,
  (ARRAY['user','assistant','tool'])[1 + (m % 3)]::message_role,
  CASE m % 3
    WHEN 0 THEN (ARRAY['Quero pedir pizza pra todo mundo','Somos 4 pessoas','Pode dividir a conta?',
                       'Prefiro algo vegano','Sem cebola, por favor','Fecha o pedido'])[1 + (m % 6)]
    WHEN 1 THEN (ARRAY['Claro! O que cada um vai querer?','Aqui estão as sugestões para você.',
                       'Carrinhos montados, posso confirmar?','Conta dividida em partes iguais.'])[1 + (m % 4)]
    ELSE        '{"tool":"getRecommendations","args":{"query":"' ||
                (ARRAY['pizza','sushi','hambúrguer','salada','açaí'])[1 + (m % 5)] || '"}}'
  END,
  now() - (u.id * interval '1 hour') - ((12 - m) * interval '2 minutes')
FROM users u
CROSS JOIN generate_series(1, 12) m;
