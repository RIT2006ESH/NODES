import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const connectionSuccess = new Rate('nodes_ws_connection_success');
const handshakeDuration = new Trend('nodes_handshake_ms');
const roundtripLatency = new Trend('nodes_action_latency_ms');
const errorRate = new Rate('nodes_error_rate');

// Scenarios for 100, 500, and 1000 users, 15m load and 1h soak options
export const options = {
  scenarios: {
    nodes_100_users: {
      executor: 'constant-vus',
      vus: 100,
      duration: '3m',
      startTime: '0s',
    },
    nodes_500_ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 250 },
        { duration: '3m', target: 500 },
        { duration: '1m', target: 0 },
      ],
      startTime: '3m',
    },
    nodes_1000_peak: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 500 },
        { duration: '3m', target: 1000 },
        { duration: '5m', target: 1000 }, // sustained
        { duration: '2m', target: 0 },
      ],
      startTime: '8m',
    },
  },
  thresholds: {
    nodes_ws_connection_success: ['rate>0.95'],
    nodes_handshake_ms: ['p(95)<1500'],
    nodes_action_latency_ms: ['p(95)<300'],
    nodes_error_rate: ['rate<0.02'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'ws://127.0.0.1:8080/ws';

export default function () {
  const startConnect = Date.now();
  const url = `${BASE_URL}?name=k6_bot_${__VU}`;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      connectionSuccess.add(true);
      handshakeDuration.add(Date.now() - startConnect);

      // Join game
      socket.send(JSON.stringify({
        type: 'join',
        name: `bot_${__VU}`,
      }));

      // Periodic movements & pings
      socket.setInterval(function () {
        const pingTime = Date.now();
        socket.send(JSON.stringify({
          type: 'ping',
          t: pingTime,
        }));
      }, 2000);
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'pong' && msg.clientNow) {
          roundtripLatency.add(Date.now() - msg.clientNow);
        }
      } catch (e) {
        errorRate.add(1);
      }
    });

    socket.on('error', function () {
      connectionSuccess.add(false);
      errorRate.add(1);
    });

    socket.setTimeout(function () {
      socket.close();
    }, 60000);
  });

  check(res, { 'connected': (r) => r && r.status === 101 });
  sleep(1);
}

