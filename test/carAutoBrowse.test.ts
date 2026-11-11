import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { beforeEach, describe, it } from 'node:test';

import type { Song } from '@/api/subsonic';

const target = 'eminem-expanded';
const songs = Array.from({ length: 38 }, (_, i) => ({
  id: `song-${i}`, title: `Track ${i}`, albumId: target,
  discNumber: i < 20 ? 1 : 2, track: i < 20 ? i + 1 : i - 19,
}));
const state = {
  target,
  profile: 'account-a', calls: [] as string[], queues: [] as { songs: Song[]; index: number }[],
  load: async () => songs,
};
Object.assign(globalThis, { __carBrowseTest: state });
const stub = (code: string) => `data:text/javascript,${encodeURIComponent(code)}`;
const prelude = 'const s=globalThis.__carBrowseTest;';
const hooks = registerHooks({ resolve(name, context, next) {
  const modules: Record<string, string> = {
    'react-native': 'export const AppState={currentState:"background"};',
    'expo-modules-core': 'export const requireOptionalNativeModule=()=>null;',
    '@/api/subsonic': '', // Inline type-only imports leave an empty runtime import in Node.
    '@/api/data': prelude + `
      const album=id=>({id,name:id,artist:'Artist'});
      export const COVER={card:300};export const coverArtUrl=()=>undefined;
      export async function getAlbumList(type){
        return (type==='newest'?Array.from({length:10},(_,i)=>'new-'+i):[s.target]).map(album);
      }
      export async function getStarred(){return {songs:[],albums:Array.from({length:18},(_,i)=>album('star-'+i)),artists:[]}}
      export async function getPlaylists(){return []}
      export async function getAlbum(id){s.calls.push(id);return {songs:id===s.target?await s.load():[{id:id+'-song',title:'Track',albumId:id}]}}
    `,
    '@/i18n': 'export const tg=x=>x;export const songsLabel=n=>String(n);',
    '@/store/auth': prelude + 'export const profileScopeId=()=>s.profile;',
    '@/store/lastPlayed': `export const useLastPlayed={getState:()=>({
      times:Object.fromEntries(Array.from({length:15},(_,i)=>['/album/recent-'+i,100-i])),
      names:Object.fromEntries(Array.from({length:15},(_,i)=>['/album/recent-'+i,'Recent '+i]))
    })};`,
    '@/store/player': prelude + 'export const usePlayerStore={getState:()=>({playQueue:async(songs,index)=>s.queues.push({songs,index})})};',
    '@/store/settings': 'export const useSettings={getState:()=>({language:"en"})};',
  };
  return name in modules ? { shortCircuit: true, url: stub(modules[name]) } : next(name, context);
} });
const treeModule = await import('@/lib/carAutoTree');
const { queryClient } = await import('@/lib/query');
hooks.deregister();

beforeEach(async () => {
  queryClient.clear();
  Object.assign(state, { profile: 'reset', calls: [], queues: [], load: async () => songs });
  await treeModule.buildBrowseTree(false);
  state.profile = 'account-a';
  queryClient.clear();
});

describe('Android Auto album loading on demand', () => {
  it('loads a visible album beyond the 40-album prefetch and queues disc 2', async () => {
    const initial = await treeModule.buildBrowseTree(true);
    assert.equal(initial.nodes['tab:home'].some(n => n.id === `album:${target}`), true);
    assert.equal(initial.nodes[`album:${target}`], undefined);
    assert.equal(state.calls.length, 40);
    const loaded = await treeModule.buildAlbumChildren(`album:${target}`, state.profile);
    assert.equal(loaded?.partial, true);
    assert.equal(loaded?.profile, 'account-a');
    assert.equal(loaded?.nodes[`album:${target}`].length, 38);
    assert.equal(state.calls.length, 41); // Only the requested album, no second full build.
    await treeModule.buildBrowseTree(true);
    await treeModule.handleBrowsePlay(loaded!.nodes[`album:${target}`][20].id);
    assert.equal(state.queues[0].songs.length, 38);
    assert.equal(state.queues[0].index, 20);
    assert.equal(state.queues[0].songs[20].discNumber, 2);
  });

  it('rejects a request for a different account without fetching', async () => {
    assert.equal(await treeModule.buildAlbumChildren(`album:${target}`, 'account-b'), null);
    assert.equal(state.calls.length, 0);
  });

  it('discards a response if the account changes while loading', async () => {
    state.load = async () => { state.profile = 'account-b'; return songs; };
    assert.equal(await treeModule.buildAlbumChildren(`album:${target}`, 'account-a'), null);
    await treeModule.handleBrowsePlay(`track|album:${target}|song-20`);
    assert.equal(state.queues.length, 0);
  });

  it('reports fetch errors rather than caching them as an empty album', async () => {
    queryClient.setDefaultOptions({ queries: { retry: false } });
    state.load = async () => { throw new Error('offline and no local album'); };
    await assert.rejects(treeModule.buildAlbumChildren(`album:${target}`, state.profile));
    state.load = async () => songs;
    assert.equal((await treeModule.buildAlbumChildren(`album:${target}`, state.profile))?.nodes[`album:${target}`].length, 38);
  });

  it('distinguishes a successfully loaded empty album from a request failure', async () => {
    state.load = async () => [];
    const tree = await treeModule.buildAlbumChildren(`album:${target}`, state.profile);
    assert.deepEqual(tree?.nodes[`album:${target}`], []);
  });

  it('does not load non-album or empty media IDs', async () => {
    for (const id of ['album:', 'tab:home', 'track|album:a|b']) {
      assert.equal(await treeModule.buildAlbumChildren(id, state.profile), null);
    }
    assert.equal(state.calls.length, 0);
  });

  it('rehydrates the full queue when native cached tracks outlive the JS maps', async () => {
    await treeModule.buildBrowseTree(false);
    await treeModule.handleBrowsePlay(`track|album:${target}|song-20`);
    assert.equal(state.calls.length, 1);
    assert.equal(state.queues[0].songs.length, 38);
    assert.equal(state.queues[0].index, 20);
  });

  it('shares concurrent requests through the existing album query cache', async () => {
    const [first, second] = await Promise.all([
      treeModule.buildAlbumChildren(`album:${target}`, state.profile),
      treeModule.buildAlbumChildren(`album:${target}`, state.profile),
    ]);
    assert.equal(state.calls.length, 1);
    assert.equal(first?.nodes[`album:${target}`].length, 38);
    assert.deepEqual(first, second);
  });
});
