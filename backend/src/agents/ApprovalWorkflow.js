const { pool } = require('../database/pool');
const nodemailer = require('nodemailer');

class ApprovalWorkflow {
  constructor(ownerEmail) {
    this.name = 'Approval Workflow';
    this.ownerEmail = ownerEmail;
    this.mailTransporter = null;
  }

  async initializeMailer() {
    this.mailTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: process.env.SMTP_PORT || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async submitForApproval(contentId) {
    console.log(`[Approval Workflow] Submitting content ${contentId} for review...`);

    const query = `
      UPDATE content
      SET status = 'pending_approval', submitted_at = NOW()
      WHERE id = $1
      RETURNING *
    `;

    const result = await pool.query(query, [contentId]);
    const content = result.rows[0];

    await this.notifyOwner(content);
    return { status: 'submitted', contentId, awaiting: 'owner approval' };
  }

  async approveContent(contentId, ownerEmail) {
    console.log(`[Approval Workflow] Approving content ${contentId}...`);

    const query = `
      UPDATE content
      SET status = 'approved', approved_at = NOW(), approved_by = $1
      WHERE id = $2
      RETURNING *
    `;

    const result = await pool.query(query, [ownerEmail, contentId]);

    console.log(`✓ Content approved: ${contentId}`);
    return result.rows[0];
  }

  async rejectContent(contentId, reason, ownerEmail) {
    console.log(`[Approval Workflow] Rejecting content ${contentId}: ${reason}`);

    const query = `
      UPDATE content
      SET status = 'rejected', rejection_reason = $1,
          reviewed_at = NOW(), reviewed_by = $2
      WHERE id = $3
      RETURNING *
    `;

    const result = await pool.query(query, [reason, ownerEmail, contentId]);
    return result.rows[0];
  }

  async notifyOwner(content) {
    if (!this.mailTransporter) await this.initializeMailer();

    const subject = `New Content Ready for Review: ${content.title}`;
    const htmlContent = `
      <h2>Content Ready for Approval</h2>
      <p><strong>Title:</strong> ${content.title}</p>
      <p><strong>Platforms:</strong> ${content.platforms.join(', ')}</p>
      <p><strong>Status:</strong> Pending Your Approval</p>
      <p>
        <a href="${process.env.DASHBOARD_URL || 'http://localhost:5173'}/content/${content.id}">
          Review Content →
        </a>
      </p>
    `;

    try {
      await this.mailTransporter.sendMail({
        from: process.env.SMTP_FROM || 'noreply@sams.social',
        to: this.ownerEmail,
        subject,
        html: htmlContent,
      });
      console.log(`✓ Notification sent to ${this.ownerEmail}`);
    } catch (error) {
      console.error('[Mail Error]', error.message);
    }
  }

  async getPendingApprovals() {
    const query = `
      SELECT id, title, caption, platforms, created_at, submitted_at
      FROM content
      WHERE status = 'pending_approval'
      ORDER BY submitted_at ASC
    `;

    const result = await pool.query(query);
    return {
      count: result.rows.length,
      items: result.rows,
    };
  }

  async getApprovalHistory(limit = 50) {
    const query = `
      SELECT id, title, status, approved_by, approved_at, rejection_reason
      FROM content
      WHERE status IN ('approved', 'rejected')
      ORDER BY approved_at DESC, reviewed_at DESC
      LIMIT $1
    `;

    const result = await pool.query(query, [limit]);
    return result.rows;
  }
}

module.exports = ApprovalWorkflow;
