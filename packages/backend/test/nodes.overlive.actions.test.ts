import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the OverliveManager singleton so each action node's
// `getOverliveManager().<method>` call is observable without a real DB/kit.
const m = {
  sendAnnouncement: vi.fn(async () => {}),
  sendShoutout: vi.fn(async () => {}),
  updateChatColor: vi.fn(async () => {}),
  updateChannel: vi.fn(async () => {}),
  createStreamMarker: vi.fn(async () => {}),
  startCommercial: vi.fn(async () => {}),
  snoozeAd: vi.fn(async () => {}),
  updateRedemptionStatus: vi.fn(async () => {}),
  banUser: vi.fn(async () => {}),
  unbanUser: vi.fn(async () => {}),
  deleteChatMessage: vi.fn(async () => {}),
  updateChatSettings: vi.fn(async () => {}),
  warnUser: vi.fn(async () => {}),
  manageAutoMod: vi.fn(async () => {}),
  addVip: vi.fn(async () => {}),
  removeVip: vi.fn(async () => {}),
  addModerator: vi.fn(async () => {}),
  removeModerator: vi.fn(async () => {}),
  createPoll: vi.fn(async () => {}),
  endPoll: vi.fn(async () => {}),
  createPrediction: vi.fn(async () => {}),
  endPrediction: vi.fn(async () => {}),
  startRaid: vi.fn(async () => {}),
  cancelRaid: vi.fn(async () => {}),
  sendWhisper: vi.fn(async () => {}),
};
vi.mock('../src/overlive/manager.js', () => ({
  getOverliveManager: () => m,
  initOverliveManager: () => m,
}));

import { loneNode } from './helpers/nodeHarness.js';

describe('overlive action nodes', () => {
  beforeEach(() => Object.values(m).forEach((fn) => fn.mockClear()));

  it('announce forwards account/message/color', () => {
    loneNode('overlive_announce', { account: 'a1', message: 'hello', color: 'purple' }).deliver('fire', undefined);
    expect(m.sendAnnouncement).toHaveBeenCalledWith('a1', 'hello', 'purple');
  });

  it('shoutout guards on missing target', () => {
    loneNode('overlive_shoutout', { account: 'a1' }).deliver('fire', undefined);
    expect(m.sendShoutout).not.toHaveBeenCalled();
    loneNode('overlive_shoutout', { account: 'a1', target: 'tgt' }).deliver('fire', undefined);
    expect(m.sendShoutout).toHaveBeenCalledWith('a1', 'tgt');
  });

  it('update channel forwards title/category/language', () => {
    loneNode('overlive_update_channel', {
      account: 'a1',
      title: 'New title',
      category: 'Just Chatting',
      language: 'en',
    }).deliver('fire', undefined);
    expect(m.updateChannel).toHaveBeenCalledWith('a1', {
      title: 'New title',
      categoryName: 'Just Chatting',
      language: 'en',
    });
  });

  it('commercial guards on missing/zero length, forwards a number', () => {
    loneNode('overlive_commercial', { account: 'a1' }).deliver('fire', undefined);
    expect(m.startCommercial).not.toHaveBeenCalled();
    loneNode('overlive_commercial', { account: 'a1', seconds: 60 }).deliver('fire', undefined);
    expect(m.startCommercial).toHaveBeenCalledWith('a1', 60);
  });

  it('snooze ad fires with just the account', () => {
    loneNode('overlive_snooze_ad', { account: 'a1' }).deliver('fire', undefined);
    expect(m.snoozeAd).toHaveBeenCalledWith('a1');
  });

  it('redemption status defaults to FULFILLED and needs both ids', () => {
    loneNode('overlive_redemption_status', { account: 'a1', rewardId: 'r1' }).deliver('fire', undefined);
    expect(m.updateRedemptionStatus).not.toHaveBeenCalled();
    loneNode('overlive_redemption_status', {
      account: 'a1',
      rewardId: 'r1',
      redemptionId: 'd1',
    }).deliver('fire', undefined);
    expect(m.updateRedemptionStatus).toHaveBeenCalledWith('a1', 'r1', 'd1', 'FULFILLED');
  });

  it('ban forwards seconds + reason; guards on missing user', () => {
    loneNode('overlive_ban_user', { account: 'a1' }).deliver('fire', undefined);
    expect(m.banUser).not.toHaveBeenCalled();
    loneNode('overlive_ban_user', { account: 'a1', userId: 'u1', seconds: 600, reason: 'spam' }).deliver('fire', undefined);
    expect(m.banUser).toHaveBeenCalledWith('a1', 'u1', 600, 'spam');
  });

  it('delete message passes id, or undefined to clear chat', () => {
    loneNode('overlive_delete_message', { account: 'a1', messageId: 'msg1' }).deliver('fire', undefined);
    expect(m.deleteChatMessage).toHaveBeenLastCalledWith('a1', 'msg1');
    loneNode('overlive_delete_message', { account: 'a1' }).deliver('fire', undefined);
    expect(m.deleteChatMessage).toHaveBeenLastCalledWith('a1', undefined);
  });

  it('chat settings parses on/off/number into a partial update', () => {
    loneNode('overlive_chat_settings', {
      account: 'a1',
      emoteOnly: 'on',
      followers: '10',
      slow: 'off',
      subscribersOnly: 'off',
      // uniqueChat omitted → left unchanged
    }).deliver('fire', undefined);
    expect(m.updateChatSettings).toHaveBeenCalledWith('a1', {
      emoteOnly: true,
      subscribersOnly: false,
      followersOnly: 10,
      slowMode: false,
    });
  });

  it('warn needs user + reason', () => {
    loneNode('overlive_warn', { account: 'a1', userId: 'u1' }).deliver('fire', undefined);
    expect(m.warnUser).not.toHaveBeenCalled();
    loneNode('overlive_warn', { account: 'a1', userId: 'u1', reason: 'rule 1' }).deliver('fire', undefined);
    expect(m.warnUser).toHaveBeenCalledWith('a1', 'u1', 'rule 1');
  });

  it('automod defaults to ALLOW', () => {
    loneNode('overlive_automod', { account: 'a1', messageId: 'mm' }).deliver('fire', undefined);
    expect(m.manageAutoMod).toHaveBeenCalledWith('a1', 'mm', 'ALLOW');
  });

  it('role nodes forward account + userId', () => {
    loneNode('overlive_add_vip', { account: 'a1', userId: 'u1' }).deliver('fire', undefined);
    expect(m.addVip).toHaveBeenCalledWith('a1', 'u1');
    loneNode('overlive_remove_moderator', { account: 'a1', userId: 'u2' }).deliver('fire', undefined);
    expect(m.removeModerator).toHaveBeenCalledWith('a1', 'u2');
  });

  it('poll create splits choices and forwards points-per-vote', () => {
    loneNode('overlive_poll_create', {
      account: 'a1',
      title: 'Best?',
      choices: 'A, B, C',
      seconds: 120,
      pointsPerVote: 50,
    }).deliver('fire', undefined);
    expect(m.createPoll).toHaveBeenCalledWith('a1', 'Best?', ['A', 'B', 'C'], 120, 50);
  });

  it('prediction create splits outcomes', () => {
    loneNode('overlive_prediction_create', {
      account: 'a1',
      title: 'Win?',
      outcomes: 'Yes, No',
      seconds: 90,
    }).deliver('fire', undefined);
    expect(m.createPrediction).toHaveBeenCalledWith('a1', 'Win?', ['Yes', 'No'], 90);
  });

  it('raid start guards on target; cancel needs only account', () => {
    loneNode('overlive_raid_start', { account: 'a1' }).deliver('fire', undefined);
    expect(m.startRaid).not.toHaveBeenCalled();
    loneNode('overlive_raid_start', { account: 'a1', target: 't1' }).deliver('fire', undefined);
    expect(m.startRaid).toHaveBeenCalledWith('a1', 't1');
    loneNode('overlive_raid_cancel', { account: 'a1' }).deliver('fire', undefined);
    expect(m.cancelRaid).toHaveBeenCalledWith('a1');
  });

  it('whisper needs user + message', () => {
    loneNode('overlive_whisper', { account: 'a1', userId: 'u1' }).deliver('fire', undefined);
    expect(m.sendWhisper).not.toHaveBeenCalled();
    loneNode('overlive_whisper', { account: 'a1', userId: 'u1', message: 'hi' }).deliver('fire', undefined);
    expect(m.sendWhisper).toHaveBeenCalledWith('a1', 'u1', 'hi');
  });

  it('every action node guards on a missing account', () => {
    loneNode('overlive_announce', { message: 'x' }).deliver('fire', undefined);
    loneNode('overlive_snooze_ad', {}).deliver('fire', undefined);
    expect(m.sendAnnouncement).not.toHaveBeenCalled();
    expect(m.snoozeAd).not.toHaveBeenCalled();
  });
});
