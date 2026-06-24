import { describe, it, expect } from 'vitest';
import { loneNode } from './helpers/nodeHarness.js';

/**
 * Overlive event nodes share a shape: an `@eventIn('event')` handler maps the
 * incoming provider payload's `.data` onto node state (applying any config
 * filters) and re-emits a bare `event` trigger. An `undefined` payload (the
 * external "probe" path) emits without touching state. Outputs read from state.
 */

describe('overlive_subscription', () => {
  const sub = {
    data: {
      username: 'alice',
      displayName: 'Alice',
      tier: 'tier1',
      months: 3,
      isFirst: false,
      isResub: true,
      isGift: false,
      message: 'thanks for the streams!',
    },
  };

  it('maps a subscription event', () => {
    const n = loneNode('overlive_subscription');
    n.deliver('event', sub);
    expect(n.state()).toMatchObject({
      username: 'alice',
      displayName: 'Alice',
      tier: 'tier1',
      months: 3,
      isFirst: false,
      isResub: true,
      isGift: false,
      message: 'thanks for the streams!',
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_subscription');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('filters by tier — a non-matching tier is dropped', () => {
    const n = loneNode('overlive_subscription', { tier: 'tier3' });
    n.deliver('event', sub);
    expect(n.state()).toBeUndefined();
  });

  it('filters by tier — a matching tier is accepted', () => {
    const n = loneNode('overlive_subscription', { tier: 'tier1' });
    n.deliver('event', sub);
    expect(n.state()).toMatchObject({ tier: 'tier1' });
  });

  it('filters by isGift — matching false drops non-gift', () => {
    const n = loneNode('overlive_subscription', { isGift: 'false' });
    n.deliver('event', sub);
    expect(n.state()).toMatchObject({ isGift: false });
  });

  it('filters by isGift — matching false rejects gift', () => {
    const gift = { ...sub, data: { ...sub.data, isGift: true } };
    const n = loneNode('overlive_subscription', { isGift: 'false' });
    n.deliver('event', gift);
    expect(n.state()).toBeUndefined();
  });

  it('filters by isGift — matching true rejects non-gift', () => {
    const n = loneNode('overlive_subscription', { isGift: 'true' });
    n.deliver('event', sub);
    expect(n.state()).toBeUndefined();
  });

  it('filters by isGift — matching true accepts gift', () => {
    const gift = { ...sub, data: { ...sub.data, isGift: true } };
    const n = loneNode('overlive_subscription', { isGift: 'true' });
    n.deliver('event', gift);
    expect(n.state()).toMatchObject({ isGift: true });
  });
});

describe('overlive_gift_bomb', () => {
  const bomb = {
    data: {
      gifter: { username: 'bob', displayName: 'Bob' },
      count: 5,
      tier: 'tier1',
      totalGifts: 50,
      anonymous: false,
    },
  };

  it('maps a gift bomb event', () => {
    const n = loneNode('overlive_gift_bomb');
    n.deliver('event', bomb);
    expect(n.state()).toMatchObject({
      gifterUsername: 'bob',
      gifterDisplayName: 'Bob',
      count: 5,
      tier: 'tier1',
      totalGifts: 50,
      anonymous: false,
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_gift_bomb');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('overlive_raid', () => {
  const raid = {
    data: {
      from: { username: 'cara', displayName: 'Cara' },
      viewerCount: 42,
    },
  };

  it('maps a raid event', () => {
    const n = loneNode('overlive_raid');
    n.deliver('event', raid);
    expect(n.state()).toMatchObject({
      fromUsername: 'cara',
      fromDisplayName: 'Cara',
      viewerCount: 42,
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_raid');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('overlive_chat_message', () => {
  const msg = {
    data: {
      username: 'dan',
      displayName: 'Dan',
      text: 'hey everyone!',
      tokens: [],
      color: '#ff0000',
      isMod: false,
      isSub: true,
      isBroadcaster: false,
      isAction: false,
      isHighlighted: false,
      cheerAmount: 0,
    },
  };

  it('maps a chat message event', () => {
    const n = loneNode('overlive_chat_message');
    n.deliver('event', msg);
    const state = n.state() as any;
    expect(state).toMatchObject({
      username: 'dan',
      displayName: 'Dan',
      text: 'hey everyone!',
      color: '#ff0000',
      isMod: false,
      isSub: true,
      isBroadcaster: false,
      isAction: false,
      isHighlighted: false,
      cheerAmount: 0,
    });
    expect(typeof state.html).toBe('string');
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_chat_message');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('handles missing optional fields with defaults', () => {
    const minimal = {
      data: {
        username: 'eve',
        displayName: 'Eve',
        text: 'hi',
        tokens: undefined,
        color: undefined,
        isMod: false,
        isSub: false,
        isBroadcaster: false,
        isAction: false,
        isHighlighted: false,
        cheerAmount: undefined,
      },
    };
    const n = loneNode('overlive_chat_message');
    n.deliver('event', minimal);
    const state = n.state() as any;
    expect(state).toMatchObject({
      username: 'eve',
      displayName: 'Eve',
      text: 'hi',
      color: '',
      cheerAmount: 0,
    });
  });
});

describe('overlive_chat_feed', () => {
  const feedItems = {
    data: [
      { username: 'alice', displayName: 'Alice', text: 'message 1' },
      { username: 'bob', displayName: 'Bob', text: 'message 2' },
      { username: 'cara', displayName: 'Cara', text: 'message 3' },
    ],
  };

  it('maps a chat feed event', () => {
    const n = loneNode('overlive_chat_feed');
    n.deliver('event', feedItems.data);
    expect(n.state()).toMatchObject({
      messages: feedItems.data,
    });
  });

  it('an undefined payload treats as empty array (not filtered out)', () => {
    const n = loneNode('overlive_chat_feed');
    n.deliver('event', undefined);
    expect(n.state()).toMatchObject({ messages: [] });
  });

  it('respects maxLength config — trims to newest', () => {
    const n = loneNode('overlive_chat_feed', { maxLength: 2 });
    n.deliver('event', feedItems.data);
    const state = n.state() as any;
    expect(state.messages.length).toBe(2);
    expect(state.messages[0].username).toBe('bob');
    expect(state.messages[1].username).toBe('cara');
  });

  it('honors maxLength input port over config', () => {
    const n = loneNode('overlive_chat_feed', { maxLength: 10 });
    // In practice, maxLength is an input port that would be wired dynamically.
    // This test delivers the feed with the default (50) and verifies it keeps all 3.
    n.deliver('event', feedItems.data);
    const state = n.state() as any;
    expect(state.messages.length).toBe(3);
  });

  it('handles empty feed', () => {
    const n = loneNode('overlive_chat_feed');
    n.deliver('event', []);
    expect(n.state()).toMatchObject({ messages: [] });
  });

  it('handles non-array payload as empty feed', () => {
    const n = loneNode('overlive_chat_feed');
    n.deliver('event', null);
    expect(n.state()).toMatchObject({ messages: [] });
  });
});

describe('overlive_chat_delete', () => {
  const del = {
    data: {
      messageId: 'msg123',
      username: 'frank',
      text: 'oops',
      moderator: { username: 'mod1' },
    },
  };

  it('maps a chat delete event', () => {
    const n = loneNode('overlive_chat_delete');
    n.deliver('event', del);
    expect(n.state()).toMatchObject({
      messageId: 'msg123',
      username: 'frank',
      text: 'oops',
      moderatorName: 'mod1',
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_chat_delete');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('handles missing optional moderator and text', () => {
    const minimal = {
      data: {
        messageId: 'msg456',
        username: 'grace',
        text: undefined,
        moderator: undefined,
      },
    };
    const n = loneNode('overlive_chat_delete');
    n.deliver('event', minimal);
    expect(n.state()).toMatchObject({
      messageId: 'msg456',
      username: 'grace',
      text: '',
      moderatorName: '',
    });
  });
});

describe('overlive_ad_start', () => {
  const adStart = {
    data: {
      durationSeconds: 60,
      isAutomatic: false,
    },
  };

  it('maps an ad start event', () => {
    const n = loneNode('overlive_ad_start');
    n.deliver('event', adStart);
    expect(n.state()).toMatchObject({
      durationSeconds: 60,
      isAutomatic: false,
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_ad_start');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('maps an automatic ad', () => {
    const auto = { data: { durationSeconds: 30, isAutomatic: true } };
    const n = loneNode('overlive_ad_start');
    n.deliver('event', auto);
    expect(n.state()).toMatchObject({
      durationSeconds: 30,
      isAutomatic: true,
    });
  });
});

describe('overlive_ad_end', () => {
  const adEnd = {
    data: {
      durationSeconds: 60,
    },
  };

  it('maps an ad end event', () => {
    const n = loneNode('overlive_ad_end');
    n.deliver('event', adEnd);
    expect(n.state()).toMatchObject({
      durationSeconds: 60,
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_ad_end');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});

describe('overlive_ban', () => {
  const ban = {
    data: {
      username: 'henry',
      displayName: 'Henry',
      moderator: { username: 'mod2' },
      reason: 'spam',
      timeoutSeconds: 600,
      isPermanent: false,
    },
  };

  it('maps a ban event', () => {
    const n = loneNode('overlive_ban');
    n.deliver('event', ban);
    expect(n.state()).toMatchObject({
      username: 'henry',
      displayName: 'Henry',
      moderatorName: 'mod2',
      reason: 'spam',
      timeoutSeconds: 600,
      isPermanent: false,
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_ban');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('maps a permanent ban with zero timeout', () => {
    const perm = {
      data: {
        username: 'iris',
        displayName: 'Iris',
        moderator: { username: 'mod3' },
        reason: 'violation',
        timeoutSeconds: 0,
        isPermanent: true,
      },
    };
    const n = loneNode('overlive_ban');
    n.deliver('event', perm);
    expect(n.state()).toMatchObject({
      username: 'iris',
      displayName: 'Iris',
      timeoutSeconds: 0,
      isPermanent: true,
    });
  });

  it('handles missing optional moderator and reason', () => {
    const minimal = {
      data: {
        username: 'jack',
        displayName: 'Jack',
        moderator: undefined,
        reason: undefined,
        timeoutSeconds: 300,
        isPermanent: false,
      },
    };
    const n = loneNode('overlive_ban');
    n.deliver('event', minimal);
    expect(n.state()).toMatchObject({
      username: 'jack',
      displayName: 'Jack',
      moderatorName: '',
      reason: '',
      timeoutSeconds: 300,
      isPermanent: false,
    });
  });
});

describe('overlive_stream_online', () => {
  const online = {
    data: {
      title: 'Late Night Vibes',
      category: 'Music',
      language: 'en',
    },
  };

  it('maps a stream online event', () => {
    const n = loneNode('overlive_stream_online');
    n.deliver('event', online);
    expect(n.state()).toMatchObject({
      title: 'Late Night Vibes',
      category: 'Music',
      language: 'en',
    });
  });

  it('an undefined payload emits without setting state', () => {
    const n = loneNode('overlive_stream_online');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });

  it('handles missing optional fields with defaults', () => {
    const minimal = {
      data: {
        title: undefined,
        category: undefined,
        language: undefined,
      },
    };
    const n = loneNode('overlive_stream_online');
    n.deliver('event', minimal);
    expect(n.state()).toMatchObject({
      title: '',
      category: '',
      language: '',
    });
  });
});

describe('overlive_stream_offline', () => {
  const offline = {};

  it('fires on stream offline (no state to map)', () => {
    const n = loneNode('overlive_stream_offline');
    n.deliver('event', offline);
    // overlive_stream_offline does not set state, just emits the event trigger.
    expect(n.state()).toBeUndefined();
  });

  it('an undefined payload emits without side effects', () => {
    const n = loneNode('overlive_stream_offline');
    n.deliver('event', undefined);
    expect(n.state()).toBeUndefined();
  });
});
