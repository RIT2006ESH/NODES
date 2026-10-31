import { createClient } from '@supabase/supabase-js';
import type { TeamView } from '@mng/protocol';
import { validateUsername, canonicalUsername, generateFallbackUsername } from './username.js';

type ProfileRow = {
  node_id: string;
  username: string;
};

function fallbackUsername(nodeId: string): string {
  return generateFallbackUsername(nodeId, () => false);
}

export interface SupabaseStore {
  verify(): Promise<void>;
  getProfile(nodeId: string): Promise<ProfileRow | null>;
  getProfileByUsername(username: string): Promise<ProfileRow | null>;
  getTeamByName(teamName: string): Promise<{ team_id: string } | null>;
  registerUsername(nodeId: string, username: string): Promise<{ ok: true; profile: ProfileRow } | { ok: false; code: string }>;
  updateUsername(nodeId: string, username: string): Promise<{ ok: true; profile: ProfileRow } | { ok: false; code: string }>;
  syncTeams(teams: readonly TeamView[]): Promise<void>;
}

export function createSupabaseStore(): SupabaseStore | null {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;

  const client = createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function getProfile(nodeId: string): Promise<ProfileRow | null> {
    const { data, error } = await client
      .from('player_profiles')
      .select('node_id,username')
      .eq('node_id', nodeId)
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getProfileByUsername(username: string): Promise<ProfileRow | null> {
    const { data, error } = await client
      .from('player_profiles')
      .select('node_id,username')
      .eq('username_normalized', canonicalUsername(username))
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function getTeamByName(teamName: string): Promise<{ team_id: string } | null> {
    const { data, error } = await client
      .from('teams')
      .select('team_id')
      .eq('team_name_normalized', teamName.trim().replace(/\s+/g, ' ').toLowerCase())
      .maybeSingle();
    if (error) throw error;
    return data;
  }

  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await client.rpc(name, args);
    if (error) throw error;
    return data as T;
  }

  async function saveUsername(nodeId: string, username: string, upsert: boolean): Promise<{ ok: true; profile: ProfileRow } | { ok: false; code: string }> {
    const valid = validateUsername(username);
    if (!valid) return { ok: false, code: 'INVALID_USERNAME' };
    const operation = upsert
      ? client.from('player_profiles').upsert({ node_id: nodeId, username: valid }, { onConflict: 'node_id' }).select('node_id,username').single()
      : client.from('player_profiles').insert({ node_id: nodeId, username: valid }).select('node_id,username').single();
    const { data, error } = await operation;
    if (error) {
      if (error.code === '23505') return { ok: false, code: 'USERNAME_TAKEN' };
      throw error;
    }
    return { ok: true, profile: data };
  }

  return {
    async verify() {
      const { error } = await client.from('player_profiles').select('node_id', { count: 'exact', head: true });
      if (error) throw error;
    },
    getProfile,
    getProfileByUsername,
    getTeamByName,
    registerUsername: (nodeId, username) => saveUsername(nodeId, username, false),
    updateUsername: (nodeId, username) => saveUsername(nodeId, username, true),
    async syncTeams(teams) {
      for (const team of teams) {
        for (const nodeId of team.memberNodeIds) {
          const { error: profileError } = await client.from('player_profiles').upsert({
            node_id: nodeId,
            username: fallbackUsername(nodeId),
          }, { onConflict: 'node_id', ignoreDuplicates: true });
          if (profileError) throw profileError;
        }
        await rpc('create_team_with_room', {
          p_team_id: team.teamId,
          p_mesh_id: team.teamId,
          p_team_name: team.name ?? team.teamId,
          p_room_id: team.roomId,
          p_leader_node_id: team.leaderNodeId,
        });
        for (const nodeId of team.memberNodeIds) {
          if (nodeId !== team.leaderNodeId) {
            await rpc('add_team_member', {
              p_team_id: team.teamId,
              p_node_id: nodeId,
            });
          }
        }
        await rpc('transfer_team_leadership', {
          p_team_id: team.teamId,
          p_new_leader_node_id: team.leaderNodeId,
        });
        if (team.name) {
          await rpc('rename_team', {
            p_team_id: team.teamId,
            p_team_name: team.name,
          });
        }
      }
    },
  };
}
