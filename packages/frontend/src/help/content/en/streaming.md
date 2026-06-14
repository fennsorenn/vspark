# Stream Accounts {#streaming}

Stream accounts are how vspark connects to your live stream platforms —
Twitch and StreamElements — so it can react to things that happen on your
channel in real time.

You don't need a developer background to get this working. Follow the steps
below to link an account, then head to the **Logic** tab to put it to use.

## What are stream accounts? {#what}

A stream account is an authorised connection between vspark and a streaming
service. Once connected, vspark can receive live events from that service —
new followers, subscriptions, chat commands, channel-point redemptions, and
more — and pass them into your Logic automations.

You manage accounts in the **Stream Accounts** panel (the account icon in
the top bar). You can connect as many accounts as you like; one is set as
the **default** and is used when no specific account is selected in a Logic
node.

## Connecting Twitch {#connect-twitch}

Connecting Twitch requires registering a free developer app at Twitch first.
This takes about two minutes and only needs to be done once per project.

1. Open the **Stream Accounts** panel and click **+ Register App**.
2. Follow the walkthrough instructions — it will ask you to visit
   `dev.twitch.tv/console/apps`, create an app there, and paste the
   **Client ID** and **Client Secret** back into vspark.
3. Once the app is saved, click **+ Twitch**. A sign-in window will open.
4. Log in with your Twitch account and click **Authorise**. vspark will
   close the window automatically when it succeeds.

Your Twitch account now appears in the list with a green **Connected** badge.

> **Tip:** If the window turns grey and nothing happens, check that your
> browser isn't blocking popups for this site.

## Connecting StreamElements {#connect-se}

StreamElements uses a JWT token instead of an OAuth flow.

1. Go to `streamelements.com/dashboard/account/channels` and copy your
   **JWT token** and **Channel ID**.
2. In vspark, open **Stream Accounts** and click **+ StreamElements**.
3. Paste the JWT and Channel ID into the form, give the account a label, and
   click **Save**.

Your StreamElements account will appear in the list immediately.

## Using accounts in Logic {#using}

Once an account is connected, its events are available as trigger nodes in
the **[Logic](topic:logic#triggers)** system. Add a trigger node (such as
*Twitch — New Follower* or *StreamElements — Redemption*) to an automation
canvas and wire it up to whatever action you want to happen.

For a full explanation of how triggers and wires work, see the
[Logic page](topic:logic#triggers).
