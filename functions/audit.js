'use strict'
const { db, admin } = require('./db')
async function writeAudit(eventType, actorId, targetId, payload = {}) {
  try {
    await db.collection('audit_events').add({
      event_type : eventType,
      user_id    : actorId,
      target_id  : targetId,
      payload    : payload,
      created_at : admin.firestore.FieldValue.serverTimestamp()
    })
  } catch (err) {
    console.error('[audit] Failed to write audit event:', eventType, err)
  }
}
module.exports = { writeAudit }
