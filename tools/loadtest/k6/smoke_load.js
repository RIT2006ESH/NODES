import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const connectionSuccess = new Rate('ws_connection_success');
const connectionDuration = new Trend('ws_connection_duration_ms');
const messageRoundTrip = new Trend('message_roundtrip_ms');
const errorsCount = new Counter('errors_count');

// Test configuration: 100 users, 500 users, or 1000 users ramp-up
export const options = {
  scenarios: {
    // 100 users baseline scenario
    scale_100: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      gracefulStop: '15s',
      env: { TARGET_USERS: '100' },
    },
  },
  thresholds: {
    ws_connection_success: ['rate>0.95'],
    ws_connection_duration_ms: ['p(95)<2000'],
    message_roundtrip_ms: ['p(95)<500'],
    errors_count: ['count<50'],
  },
};

const BASE_URL = __ENV.TARGET_URL || 'ws://127.0.0.1:10001/ws';
const ROOM_ID = __ENV.ROOM_ID || 'loadtest-room';

export default function () {
  const startConnect = Date.now();
  const url = `${BASE_URL}?ticket=mock-ticket-${__VU}-${Date.now()}`;

  const params = {
    tags: { my_tag: 'smoke_user' },
  };

  const res = ws.connect(url, params, function (socket) {
    connectionDuration.add(Date.now() - startConnect);
    connectionSuccess.add(true);

    socket.on('open', function () {
      // Simulate periodic chat messages
      socket.setInterval(function () {
        const sendTime = Date.now();
        const payload = JSON.stringify({
          t: 'room:message',
          roomId: ROOM_ID,
          text: `load test msg from VU ${__VU} at ${sendTime}`,
          sentAt: sendTime,
        });
        socket.send(payload);
      }, 3000);
    });

    socket.on('message', function (data) {
      try {
        const msg = JSON.parse(data);
        if (msg.t === 'room:message' && msg.sentAt) {
          const rtt = Date.now() - msg.sentAt;
          messageRoundTrip.add(rtt);
        }
      } catch (e) {
        // non-json or unparsed
      }
    });

    socket.on('close', function () {
      // closed
    });

    socket.on('error', function (e) {
      errorsCount.add(1);
      connectionSuccess.add(false);
    });

    // Session length per VU
    socket.setTimeout(function () {
      socket.close();
    }, 45000);
  });

  check(res, { 'status is 101': (r) => r && r.status === 101 });
  sleep(1);
}

