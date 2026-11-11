// Install and privacy page. Permissions: View Channel (1024) + Send Messages (2048) + Embed Links (16384).
export const dynamic = "force-dynamic";

const PERMISSIONS = 1024 + 2048 + 16384;

export default function Home() {
  const appId = process.env.DISCORD_APP_ID;
  const contact = process.env.CONTACT_EMAIL;
  const installUrl = appId
    ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(appId)}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`
    : null;
  return (
    <main>
      <h1>Field Report</h1>
      <p>A Discord bot that posts a monthly cEDH meta report for the region your server chooses.</p>
      {installUrl ? <p><a href={installUrl}>Add Field Report to a server</a></p> : <p>Install link unavailable (app not configured).</p>}
      <p>It asks only for View Channel, Send Messages and Embed Links. Commands are limited to members with Manage Server.</p>

      <h2>Privacy</h2>
      <p>
        For each server we store the server ID, the chosen channel ID, the chosen region, and the last month a report was posted.
        We store nothing about server members. After the bot is removed from a server, that server&apos;s settings are deleted the next
        time the monthly report job runs. A server admin who wants them deleted sooner can write to the contact address below.
      </p>
      <p>
        If a server admin builds a custom region, we store the name they gave it and the places in it: cities, states, countries,
        continents, and areas around a city (the city chosen as the center and a distance in kilometres).
        These belong to that server, are not visible to any other server, hold no user data, and are deleted with the server&apos;s settings.
      </p>
      <p>
        Tournament data comes from public TopDeck.gg results. For players with a TopDeck account we store only the TopDeck player ID and display name,
        refreshed from TopDeck, to name event winners and top performers. We do not store decklists or Discord details.
      </p>
      <p>If you don&apos;t want your name shown in reports, write to the contact address below and we will stop naming you.</p>
      <p>Contact: {contact ? <a href={`mailto:${contact}`}>{contact}</a> : "not yet published"}</p>

      <p>
        Data provided by <a href="https://topdeck.gg">TopDeck.gg</a>. Stat methods follow <a href="https://cedhstats.org/about">cedhstats.org</a>.
      </p>
    </main>
  );
}
