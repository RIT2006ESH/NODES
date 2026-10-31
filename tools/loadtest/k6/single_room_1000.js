import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const connectionSuccess = new Rate('ws_connection_success');
const connectionDuration = new Trend('ws_connection_duration_ms');
const messageBroadcastLatency = new Trend('message_fanout_ms');
const errorsCount = new Counter('errors_count');

// Scenario: 1,000 concurrent members in a single room with 15m load / 1h soak options
export const options = {
  scenarios: {
    single_room_1000: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 250 },
        { duration: '3m', target: 500 },
        { duration: '3m', target: 1000 },
        { duration: '5m', target: 1000 }, // steady load
        { duration: '2m', target: 0 },
      ],
      gracefulStop: '30s',
    },
    // To run the 1-hour soak test, pass: -e SOAK=true or switch scenario
  },
  thresholds: {
    ws_connection_success: ['rate>0.98'],
    ws_connection_duration_ms: ['p(95)<3000'],
    message_fanout_ms: ['p(95)<800'],
    errors_count: ['count<100'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'ws://127.0.0.1:10001/ws';
const ROOM_ID = 'mega-room-1000';

export default function () {
  const startConnect = Date.now();
  const url = `${BASE_URL}?ticket=ticket-${__VU}`;

  const res = ws.connect(url, {}, function (socket) {
    connectionDuration.add(Date.now() - startConnect);
    connectionSuccess.add(true);

    socket.on('open', function () {
      // VU 1-10 act as active chatters; remaining VUs receive broadcast
      if (__VU <= 10) {
        socket.setInterval(function () {
          const sent = Date.now();
          socket.send(JSON.stringify({
            t: 'room:message',
            roomId: ROOM_ID,
            text: `Broadcast from active speaker ${__VU}`,
            sentAt: sent,
          }));
        }, 1000);
      }
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.sentAt) {
          messageBroadcastLatency.add(Date.now() - msg.sentAt);
        }
      } catch (e) {}
    });

    socket.on('error', function () {
      errorsCount.add(1);
      connectionSuccess.add(false);
    });

    const sessionDurationMs = __ENV.SOAK === 'true' ? 3600000 : 300000;
    socket.setTimeout(function () {
      socket.close();
    }, sessionDurationMs);
  });

  check(res, { 'connected': (r) => r && r.status === 101 });
  sleep(1);
}

