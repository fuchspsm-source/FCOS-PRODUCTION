'use strict'

/**
 * Build the "PSM rejected" notification email for the submitter.
 * Pure function — no Firestore access.
 *
 * @param {Object} params
 * @param {string} params.approval_request_id
 * @param {string} params.request_number
 * @param {string} params.summary
 * @param {string} params.submitter_name
 * @param {string} params.psm_id
 * @param {number} params.aggregate_nc
 * @param {string} params.validity_from
 * @param {string} params.validity_to
 * @param {string} params.decision_comment
 * @param {string} params.rejected_by_name
 * @returns {{subject: string, html: string}}
 */
function buildPsmRejectedEmail({
  approval_request_id,
  request_number,
  summary,
  submitter_name,
  psm_number,
  aggregate_nc,
  validity_from,
  validity_to,
  decision_comment,
  rejected_by_name
}) {
  const subject = `FCOS: PSM ${request_number} Rejected`

  const html = `
    <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
      <div style="background-color: #1a1a2e; color: #ffffff; padding: 16px 24px;">
        <div style="font-size: 14px; opacity: 0.8;">Fuchs Lubricants Indonesia - System</div>
        <div style="font-size: 18px; font-weight: bold; margin-top: 4px;">PSM Rejected</div>
      </div>
      <div style="padding: 24px; border: 1px solid #e0e0e0;">
        <p>Dear ${submitter_name},</p>
        <p>Your PSM submission has been rejected by ${rejected_by_name}.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 0; color: #666; width: 180px;">Request Number</td>
            <td style="padding: 8px 0; font-weight: bold;">${request_number}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">PSM Number</td>
            <td style="padding: 8px 0;">${psm_number || "-"}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Summary</td>
            <td style="padding: 8px 0;">${summary}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Aggregate NC</td>
            <td style="padding: 8px 0;">${aggregate_nc}%</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Validity Period</td>
            <td style="padding: 8px 0;">${validity_from} ~ ${validity_to}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666; vertical-align: top;">Reason</td>
            <td style="padding: 8px 0;">${decision_comment}</td>
          </tr>
        </table>
        <p>Please review the feedback and resubmit if necessary.</p>
      </div>
      <div style="padding: 16px 24px; font-size: 12px; color: #999;">
        This is an automated notification from FCOS. Please do not reply to this email.
      </div>
    </div>
  `.trim()

  return { subject, html }
}

module.exports = { buildPsmRejectedEmail }
