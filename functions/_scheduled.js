// ======================================
// SAHDONG - AUTO HAPUS UNDANGAN EXPIRED + H+7
// ======================================
// File: functions/_scheduled.js
// Jalan tiap hari jam 02:00 WIB (cron "0 19 * * *" UTC)
// Yang dihapus: invitations + guestbook + foto R2 + MP3 R2
// Yang TETAP: users + sessions + orders + payments
//   (orders.invitation_id di-NULL-kan dulu, biar riwayat beli tetap ada
//    dan pemilik masih bisa login + beli lagi)

function getJakartaNow() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const v = {};
  for (const p of parts) {
    if (p.type !== "literal") v[p.type] = p.value;
  }
  // Pakai UTC biar gampang dikurang 7 hari
  return new Date(Date.UTC(
    Number(v.year), Number(v.month) - 1, Number(v.day),
    Number(v.hour), Number(v.minute), Number(v.second)
  ));
}

function formatDateTimeUTC(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export async function onScheduled({ env }) {
  try {
    if (!env.DB) {
      console.error("SAHDONG CLEANUP: Database tidak tersedia.");
      return;
    }

    const now = getJakartaNow();
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoffStr = formatDateTimeUTC(cutoff);

    // Cari undangan yang sudah lewat 7 hari dari expires_at.
    // Status apa pun yang punya expires_at (published / archived).
    const result = await env.DB.prepare(`
      SELECT id, slug, title, expires_at, invitation_data
      FROM invitations
      WHERE expires_at IS NOT NULL
        AND expires_at <= ?
      ORDER BY expires_at ASC
      LIMIT 100
    `).bind(cutoffStr).all();

    const invitations = result.results || [];
    if (invitations.length === 0) {
      console.log("SAHDONG CLEANUP: tidak ada undangan expired +H+7.");
      return;
    }

    let deletedInvitations = 0;
    let deletedGallery = 0;
    let deletedMusic = 0;
    let deletedGuestbook = 0;

    for (const inv of invitations) {
      // 1. Kumpulkan key R2 dari invitation_data
      const galleryKeys = [];
      let musicKey = null;
      try {
        const data = JSON.parse(inv.invitation_data || "{}");
        if (Array.isArray(data.gallery)) {
          for (const photo of data.gallery) {
            if (photo && photo.key) galleryKeys.push(photo.key);
          }
        }
        if (data.portraits && typeof data.portraits === "object") {
          for (const side of ["groom", "bride"]) {
            const p = data.portraits[side];
            if (p && p.key) galleryKeys.push(p.key);
          }
        }
        if (data.music && data.music.mode === "upload" && data.music.key) {
          musicKey = data.music.key;
        }
      } catch {
        // Kalau invitation_data rusak, tetap lanjut hapus row-nya.
        // File R2 yang tidak kebaca key-nya tidak bisa dihapus di sini.
      }

      // 2. Hapus file R2 dulu (biar tidak jadi sampah kalau row gagal dihapus)
      if (env.GALLERY) {
        for (const key of galleryKeys) {
          try {
            await env.GALLERY.delete(key);
            deletedGallery++;
          } catch (e) {
            console.error(`SAHDONG CLEANUP: gagal hapus GALLERY ${key} (${inv.id}):`, e);
          }
        }
      }
      if (env.MUSIC && musicKey) {
        try {
          await env.MUSIC.delete(musicKey);
          deletedMusic++;
        } catch (e) {
          console.error(`SAHDONG CLEANUP: gagal hapus MUSIC ${musicKey} (${inv.id}):`, e);
        }
      }

      // 3. Hapus guestbook-nya (jaga-jaga kalau FK CASCADE tidak aktif)
      try {
        const gb = await env.DB.prepare(
          `DELETE FROM guestbook WHERE invitation_id = ?`
        ).bind(inv.id).run();
        deletedGuestbook += (gb.meta && gb.meta.changes) || 0;
      } catch (e) {
        console.error(`SAHDONG CLEANUP: gagal hapus guestbook ${inv.id}:`, e);
      }

      // 4. NULL-kan orders.invitation_id biar riwayat beli tetap ada
      try {
        await env.DB.prepare(
          `UPDATE orders SET invitation_id = NULL WHERE invitation_id = ?`
        ).bind(inv.id).run();
      } catch (e) {
        console.error(`SAHDONG CLEANUP: gagal NULL-kan orders ${inv.id}:`, e);
      }

      // 5. Hapus row invitations-nya
      const del = await env.DB.prepare(
        `DELETE FROM invitations WHERE id = ?`
      ).bind(inv.id).run();

      if (del.meta && del.meta.changes === 1) {
        deletedInvitations++;
        console.log(`SAHDONG CLEANUP: hapus ${inv.slug} (expired ${inv.expires_at})`);
      }
    }

    console.log(
      `SAHDONG CLEANUP SELESAI: undangan=${deletedInvitations}, gallery=${deletedGallery}, musik=${deletedMusic}, guestbook=${deletedGuestbook}`
    );
  } catch (error) {
    console.error("SAHDONG CLEANUP ERROR:", error);
  }
}
