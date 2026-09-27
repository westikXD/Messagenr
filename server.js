/**
 * server.js
 * -----------------------------------------------------------------------
 * Простой сервер мессенджера.
 *
 * Что делает:
 *  1. Раздаёт статические файлы фронтенда (папка /public).
 *  2. Через Socket.io обрабатывает:
 *     - вход пользователя по нику (login)
 *     - список онлайн-пользователей (users-list)
 *     - обмен текстовыми сообщениями и фото в base64 (private-message)
 *     - сигнализацию WebRTC для звонков (call-user, answer-call,
 *       ice-candidate, end-call)
 *
 * Хранилище — в памяти процесса (Map), без базы данных.
 * Этого достаточно для демонстрации/локального использования.
 * -----------------------------------------------------------------------
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Отдаём статику фронтенда
app.use(express.static(path.join(__dirname, 'public')));

// nickname -> socket.id
const users = new Map();
// socket.id -> nickname (для быстрого доступа при disconnect)
const socketToNick = new Map();

/** Рассылает всем клиентам актуальный список ников онлайн */
function broadcastUsersList() {
  io.emit('users-list', Array.from(users.keys()));
}

io.on('connection', (socket) => {
  console.log(`[connect] сокет ${socket.id} подключился`);

  // --- Авторизация по нику -------------------------------------------
  socket.on('login', (nickname, callback) => {
    nickname = String(nickname || '').trim();

    if (!nickname) {
      return callback({ ok: false, error: 'Ник не может быть пустым' });
    }
    if (users.has(nickname)) {
      return callback({ ok: false, error: 'Этот ник уже занят' });
    }

    users.set(nickname, socket.id);
    socketToNick.set(socket.id, nickname);
    socket.data.nickname = nickname;

    callback({ ok: true, nickname });
    broadcastUsersList();
    console.log(`[login] ${nickname} вошёл в чат`);
  });

  // --- Текстовое сообщение / фото (в виде base64 data-URL) ------------
  // payload: { to: string, text?: string, image?: string(dataURL), ts: number }
  socket.on('private-message', (payload) => {
    const from = socket.data.nickname;
    if (!from) return; // не авторизован

    const targetSocketId = users.get(payload.to);
    const message = {
      from,
      text: payload.text || '',
      image: payload.image || null,
      ts: payload.ts || Date.now(),
    };

    // Отправляем получателю (если он онлайн)
    if (targetSocketId) {
      io.to(targetSocketId).emit('private-message', message);
    }
    // Возвращаем копию отправителю, чтобы его собственный интерфейс
    // тоже обновился (подтверждение доставки на сервер)
    socket.emit('private-message', { ...message, self: true, to: payload.to });
  });

  // --- Сигнализация WebRTC для звонков ---------------------------------
  // Инициатор отправляет offer
  socket.on('call-user', ({ to, offer, callType }) => {
    const targetSocketId = users.get(to);
    if (!targetSocketId) {
      socket.emit('call-failed', { reason: 'Пользователь не в сети' });
      return;
    }
    io.to(targetSocketId).emit('incoming-call', {
      from: socket.data.nickname,
      offer,
      callType, // 'audio' | 'video'
    });
  });

  // Принимающий отвечает answer
  socket.on('answer-call', ({ to, answer }) => {
    const targetSocketId = users.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-answered', { from: socket.data.nickname, answer });
    }
  });

  // Обмен ICE-кандидатами в обе стороны
  socket.on('ice-candidate', ({ to, candidate }) => {
    const targetSocketId = users.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('ice-candidate', { from: socket.data.nickname, candidate });
    }
  });

  // Завершение / отклонение звонка
  socket.on('end-call', ({ to }) => {
    const targetSocketId = users.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('call-ended', { from: socket.data.nickname });
    }
  });

  // --- Отключение -------------------------------------------------------
  socket.on('disconnect', () => {
    const nickname = socketToNick.get(socket.id);
    if (nickname) {
      users.delete(nickname);
      socketToNick.delete(socket.id);
      broadcastUsersList();
      console.log(`[disconnect] ${nickname} вышел`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер мессенджера запущен: http://localhost:${PORT}`);
});
