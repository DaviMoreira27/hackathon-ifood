INSERT INTO users (name, email, ifood_token, token_expires_at) VALUES
  ('Pedro Bernardes', 'pedro@example.com',  'tok_pedro_mock_001',  now() + interval '7 days'),
  ('Maria Silva',     'maria@example.com',  'tok_maria_mock_002',  now() + interval '7 days'),
  ('João Santos',     'joao@example.com',   'tok_joao_mock_003',   now() + interval '1 day'),
  ('Ana Costa',       'ana@example.com',    'tok_ana_mock_004',    now() - interval '1 day'),
  ('Lucas Oliveira',  'lucas@example.com',  NULL,                  NULL);

INSERT INTO orders (owner_user_id, status, created_at) VALUES
  (1, 'paid',       now() - interval '3 days'),
  (1, 'paying',     now() - interval '2 hours'),
  (2, 'confirmed',  now() - interval '1 day'),
  (3, 'collecting', now() - interval '10 minutes'),
  (4, 'paid',       now() - interval '5 days'),
  (5, 'collecting', now());

INSERT INTO carts (order_id, ifood_cart_id, subtotal, total, status) VALUES
  (1, 'cart_ifood_1001', 42.90, 47.90, 'paid'),
  (1, 'cart_ifood_1002', 38.50, 43.50, 'paid'),
  (2, 'cart_ifood_2001', 59.80, 64.80, 'confirmed'),
  (2, 'cart_ifood_2002', 29.00, 34.00, 'pending'),
  (2, 'cart_ifood_2003', 31.50, 36.50, 'confirmed'),
  (3, 'cart_ifood_3001', 75.00, 80.00, 'confirmed'),
  (4, 'cart_ifood_4001', 22.90, 27.90, 'pending'),
  (5, 'cart_ifood_5001', 54.20, 59.20, 'paid'),
  (5, 'cart_ifood_5002', 18.90, 23.90, 'paid'),
  (6, 'cart_ifood_6001', 36.00, 41.00, 'pending');

INSERT INTO chats (id, channel, external_id) VALUES
  (1001, 'telegram', '1001'),
  (1002, 'telegram', '1002'),
  (1003, 'telegram', '1003'),
  (1004, 'telegram', '1004');
SELECT setval('chats_id_seq', (SELECT max(id) FROM chats));

INSERT INTO messages (chat_id, user_id, role, content, created_at) VALUES
  (1001, 1, 'user',      'Quero pedir pra 3 pessoas',                                   now() - interval '2 hours 10 minutes'),
  (1001, 1, 'assistant', 'Claro! Quem são os participantes e o que cada um quer comer?', now() - interval '2 hours 9 minutes'),
  (1001, 1, 'user',      'Eu quero pizza, a Maria quer hambúrguer e o João sushi',      now() - interval '2 hours 8 minutes'),
  (1001, 1, 'tool',      '{"tool":"getRecommendations","args":{"query":"pizza"}}',      now() - interval '2 hours 7 minutes'),
  (1001, 1, 'assistant', 'Sugestões de pizza: Pizza Hut Calabresa (R$ 42,90)...',       now() - interval '2 hours 6 minutes'),
  (1001, 1, 'user',      'Pode fechar e dividir a conta',                               now() - interval '2 hours'),
  (1001, 1, 'assistant', 'Pedido confirmado! Enviei o token de pagamento para cada um.', now() - interval '1 hour 59 minutes'),
  (1002, 2, 'user',      'Oi, quero pedir um lanche',                                   now() - interval '1 day'),
  (1002, 2, 'assistant', 'Olá Maria! Qual tipo de lanche você prefere?',                now() - interval '1 day' + interval '1 minute'),
  (1003, 3, 'user',      'Somos 4, queremos comida japonesa',                           now() - interval '10 minutes'),
  (1003, 3, 'assistant', 'Ótimo! Vou buscar opções de comida japonesa para o grupo.',   now() - interval '9 minutes'),
  (1004, NULL, 'user',   'mensagem de usuário ainda não cadastrado',                    now() - interval '1 minute');
