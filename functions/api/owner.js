import { getUniverseDetails, getEnvConfig, json } from "./_helpers.js";

// GET /api/owner?iconType=group|owner
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }

  try {
    const { universeId } = getEnvConfig(env);
    if (!universeId) {
      return json({ error: "Server not configured. Set UNIVERSE_ID in Cloudflare env vars." }, 500);
    }

    const universe = await getUniverseDetails(universeId);
    if (!universe) {
      return json({ error: "Could not fetch universe details" }, 500);
    }

    const creator = universe.creator;
    const url = new URL(request.url);
    const iconType = url.searchParams.get("iconType");

    let targetType = creator.type;
    let targetId = creator.id;
    let resolvedOwnerName = creator.name;
    let thumbnailUrl = null;

    // If game is owned by a group, but the user requested the owner's avatar
    if (creator.type === "Group" && (iconType === "owner" || iconType === "group-owner")) {
      try {
        const groupRes = await fetch(`https://groups.rotunnel.com/v1/groups/${creator.id}`);
        if (groupRes.ok) {
          const groupData = await groupRes.json();
          if (groupData && groupData.owner) {
            targetType = "User";
            targetId = groupData.owner.userId || groupData.owner.id;
            resolvedOwnerName = groupData.owner.username || groupData.owner.name;
          }
        }
      } catch (err) {
        console.warn("Could not fetch group owner details:", err?.message || err);
      }
    }

    // Fetch the resolved thumbnail
    if (targetType === "Group") {
      const thumbRes = await fetch(`https://thumbnails.rotunnel.com/v1/groups/icons?groupIds=${targetId}&size=150x150&format=Png`);
      if (thumbRes.ok) {
        const thumbData = await thumbRes.json();
        if (thumbData && thumbData.data && thumbData.data.length > 0) {
          thumbnailUrl = thumbData.data[0].imageUrl;
        }
      }
    } else {
      const thumbRes = await fetch(`https://thumbnails.rotunnel.com/v1/users/avatar-headshot?userIds=${targetId}&size=150x150&format=Png&isCircular=false`);
      if (thumbRes.ok) {
        const thumbData = await thumbRes.json();
        if (thumbData && thumbData.data && thumbData.data.length > 0) {
          thumbnailUrl = thumbData.data[0].imageUrl;
        }
      }
    }

    // Cache on Cloudflare's edge for 1 hour, serve stale in background.
    // (Pages Functions respects Cache-Control via the CDN.)
    return json(
      {
        name: creator.name,
        id: creator.id,
        type: creator.type,
        ownerName: resolvedOwnerName,
        ownerId: targetId,
        thumbnailUrl,
      },
      200,
      { "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400" }
    );
  } catch (err) {
    console.error("Error in owner handler:", err?.stack || err?.message || err);
    return json({ error: "Internal server error" }, 500);
  }
}
