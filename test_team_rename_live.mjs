import { WebSocket } from 'ws';

function createClient() {
  let ws;
  const messages = [];
  return {
    async connect(url) {
      ws = new WebSocket(url);
      await new Promise((res, rej) => {
        ws.on('open', res);
        ws.on('error', rej);
      });
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw);
        messages.push(msg);
      });
    },
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    async wait(predicate, timeout = 3000) {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const idx = messages.findIndex(predicate);
        if (idx !== -1) {
          return messages.splice(idx, 1)[0];
        }
        await new Promise(r => setTimeout(r, 50));
      }
      throw new Error('Timeout waiting for message. Received: ' + JSON.stringify(messages.map(m => m.type)));
    },
    close() {
      ws?.close();
    }
  };
}

async function run() {
  console.log('Connecting c1 and c2...');
  const c1 = createClient();
  const c2 = createClient();
  await c1.connect('ws://localhost:10000/ws');
  await c2.connect('ws://localhost:10000/ws');

  c1.send({ type: 'join', name: 'AlphaPlayer' });
  const w1 = await c1.wait(m => m.type === 'welcome');
  const snap1 = await c1.wait(m => m.type === 'snapshot');
  console.log('Alpha joined as', snap1.you.nodeId);

  c2.send({ type: 'join', name: 'BetaPlayer' });
  const w2 = await c2.wait(m => m.type === 'welcome');
  const snap2 = await c2.wait(m => m.type === 'snapshot');
  console.log('Beta joined as', snap2.you.nodeId);

  // Alpha requests link to Beta
  c1.send({ type: 'request_link', targetNodeId: snap2.you.nodeId });
  const req = await c2.wait(m => m.type === 'link_request');
  console.log('Beta received request:', req.requestId);

  // Beta accepts link
  c2.send({ type: 'respond_link', requestId: req.requestId, accept: true });
  const res1 = await c1.wait(m => m.type === 'request_result' && m.status === 'accepted');
  console.log('Link accepted!');

  const snapTeam = await c1.wait(m => m.type === 'snapshot' || (m.type === 'delta' && m.teams?.length > 0));
  console.log('Team formed:', snapTeam.teams);

  const team = snapTeam.teams.find(t => t.memberNodeIds.includes(snap1.you.nodeId));
  console.log('Leader is:', team.leaderNodeId);

  // Now leader renames team
  console.log('Alpha sending team_name for teamId:', team.teamId);
  c1.send({
    type: 'team_name',
    teamId: team.teamId,
    name: 'Thunder Warriors',
    description: 'We test teams'
  });

  const nextMsg = await c1.wait(m => (m.type === 'snapshot' && m.teams?.some(t => t.name === 'Thunder Warriors')) || m.type === 'error', 4000);
  console.log('Server response to team_name:', nextMsg.type, nextMsg);

  c1.close();
  c2.close();
}

run().catch(console.error);

