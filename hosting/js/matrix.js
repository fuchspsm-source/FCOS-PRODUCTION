/**
 * FCOS — matrix.js
 * Batch 5E Revised: Approval Matrix UI logic
 * Consumes: listMatrix, getMatrix, createMatrix, closeMatrix, listUsers
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentMatrixId = null;
  let userCache       = [];

  // ── DOM refs ─────────────────────────────────────────────────
  const elTableBody        = document.getElementById('matrix-table-body');
  const elCreateModal      = document.getElementById('modal-create-matrix');
  const elDetailModal      = document.getElementById('modal-matrix-detail');
  const elBtnSave          = document.getElementById('btn-save-matrix');
  const elBtnCloseMatrix   = document.getElementById('btn-close-matrix');
  const elSelectSalesOwner = document.getElementById('select-sales-owner');
  const elSelectRm         = document.getElementById('select-rm');
  const elSelectDm         = document.getElementById('select-dm');
  const elSelectSd         = document.getElementById('select-sd');
  const elSelectMd         = document.getElementById('select-md');
  const elInputEffFrom     = document.getElementById('input-effective-from');
  const elDetailSalesOwner = document.getElementById('detail-sales-owner');
  const elDetailRm         = document.getElementById('detail-rm');
  const elDetailDm         = document.getElementById('detail-dm');
  const elDetailSd         = document.getElementById('detail-sd');
  const elDetailMd         = document.getElementById('detail-md');
  const elDetailEffFrom    = document.getElementById('detail-effective-from');
  const elDetailEffTo      = document.getElementById('detail-effective-to');
  const elDetailStatus     = document.getElementById('detail-status');

  // ── Role map (mirrors backend MATRIX_ROLE_MAP) ────────────────
  const SLOT_ROLE_MAP = {
    'select-sales-owner' : 'AREA_MANAGER',
    'select-rm'          : 'REGIONAL_MANAGER',
    'select-dm'          : 'DIVISION_MANAGER',
    'select-sd'          : 'SALES_DIRECTOR',
    'select-md'          : 'MANAGING_DIRECTOR',
  };

  // ── Helpers ──────────────────────────────────────────────────

  function openModal(el)  { el.classList.add('is-open'); }
  function closeModal(el) { el.classList.remove('is-open'); }

  function statusBadge(isActive) {
    const active = isActive === true || String(isActive).toUpperCase() === 'ACTIVE';
    const label  = active ? 'Active' : 'Inactive';
    const cls    = active ? 'badge-active' : 'badge-inactive';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g,  '&amp;')
      .replace(/</g,  '&lt;')
      .replace(/>/g,  '&gt;')
      .replace(/"/g,  '&quot;')
      .replace(/'/g,  '&#39;');
  }

  function getUserName(uid) {
    const u = userCache.find(function (u) { return u.uid === uid; });
    return u ? u.name : uid;
  }

  function formatDate(val) {
    if (!val) return '—';
    // Firestore Timestamp shape: { _seconds, _nanoseconds } or { seconds }
    let ts = val;
    if (val && typeof val === 'object' && (val._seconds || val.seconds)) {
      ts = new Date((val._seconds || val.seconds) * 1000);
    } else {
      ts = new Date(val);
    }
    if (isNaN(ts.getTime())) return String(val);
    return ts.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function clearCreateForm() {
    elSelectSalesOwner.value = '';
    elSelectRm.value         = '';
    elSelectDm.value         = '';
    elSelectSd.value         = '';
    elSelectMd.value         = '';
    elInputEffFrom.value     = '';
  }

  function showError(err) {
    console.error(err);
    alert(err.message || 'Operation failed');
  }

  // ── Users ─────────────────────────────────────────────────────

  async function loadUsers() {
    try {
      const result = await listUsers('ACTIVE');
      userCache = result.users || [];
      populateAllSelects();
    } catch (err) {
      showError(err);
    }
  }

  function populateSelect(el, role) {
    const filtered = userCache.filter(function (u) {
      return Array.isArray(u.roles) && u.roles.includes(role);
    });

    // Keep the default disabled option, remove any previously injected options
    while (el.options.length > 1) el.remove(1);

    if (filtered.length === 0) {
      const opt = document.createElement('option');
      opt.value    = '';
      opt.disabled = true;
      opt.textContent = '— No users with this role —';
      el.appendChild(opt);
      return;
    }

    filtered.forEach(function (u) {
      const opt = document.createElement('option');
      opt.value       = u.uid;
      opt.textContent = u.name + ' (' + u.email + ')';
      el.appendChild(opt);
    });
  }

  function populateAllSelects() {
    populateSelect(elSelectSalesOwner, 'AREA_MANAGER');
    populateSelect(elSelectRm,         'REGIONAL_MANAGER');
    populateSelect(elSelectDm,         'DIVISION_MANAGER');
    populateSelect(elSelectSd,         'SALES_DIRECTOR');
    populateSelect(elSelectMd,         'MANAGING_DIRECTOR');
  }

  // ── List ─────────────────────────────────────────────────────

  async function loadMatrixList() {
    try {
      const result = await listMatrix();
      renderTable(result.matrix);
    } catch (err) {
      showError(err);
    }
  }

  function renderTable(records) {
    if (!records || records.length === 0) {
      elTableBody.innerHTML = `
        <tr>
          <td colspan="3" style="text-align:center;color:var(--color-text-secondary,#6b7280);padding:32px 16px;">
            No approval matrix found.
          </td>
        </tr>`;
      return;
    }

    elTableBody.innerHTML = records.map(function (row) {
      return `
        <tr>
          <td>${escapeHtml(getUserName(row.sales_owner_id))}</td>
          <td>${statusBadge(row.is_active)}</td>
          <td class="col-action">
            <button
              class="btn btn-ghost"
              type="button"
              data-matrix-id="${escapeHtml(String(row.id))}"
            >View</button>
          </td>
        </tr>`;
    }).join('');
  }

  // ── View ─────────────────────────────────────────────────────

  async function handleViewMatrix(matrixId) {
    try {
      const data = await getMatrix(matrixId);
      populateDetail(data, matrixId);
      openModal(elDetailModal);
    } catch (err) {
      showError(err);
    }
  }

  function populateDetail(data, matrixId) {
    currentMatrixId = matrixId;
    elBtnCloseMatrix.dataset.matrixId = matrixId;

    elDetailSalesOwner.textContent = getUserName(data.sales_owner_id);
    elDetailRm.textContent         = getUserName(data.rm_id);
    elDetailDm.textContent         = getUserName(data.dm_id);
    elDetailSd.textContent         = getUserName(data.sd_id);
    elDetailMd.textContent         = getUserName(data.md_id);
    elDetailEffFrom.textContent    = formatDate(data.effective_from);
    elDetailEffTo.textContent      = data.effective_to ? formatDate(data.effective_to) : '—';
    elDetailStatus.innerHTML       = statusBadge(data.is_active);
  }

  // ── Create ────────────────────────────────────────────────────

  async function handleSaveMatrix() {
    const salesOwnerId = elSelectSalesOwner.value;
    const rmId         = elSelectRm.value;
    const dmId         = elSelectDm.value;
    const sdId         = elSelectSd.value;
    const mdId         = elSelectMd.value;
    const effFrom      = elInputEffFrom.value;

    if (!salesOwnerId || !rmId || !dmId || !sdId || !mdId || !effFrom) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = {
      sales_owner_id : salesOwnerId,
      rm_id          : rmId,
      dm_id          : dmId,
      sd_id          : sdId,
      md_id          : mdId,
      effective_from : effFrom,
    };

    try {
      elBtnSave.disabled = true;
      await createMatrix(payload);
      closeModal(elCreateModal);
      clearCreateForm();
      await loadMatrixList();
    } catch (err) {
      showError(err);
    } finally {
      elBtnSave.disabled = false;
    }
  }

  // ── Close Matrix ──────────────────────────────────────────────

  async function handleCloseMatrix() {
    if (!currentMatrixId) return;
    const confirmed = confirm('Close this matrix? This action cannot be undone.');
    if (!confirmed) return;

    try {
      elBtnCloseMatrix.disabled = true;
      await closeMatrix(currentMatrixId);
      closeModal(elDetailModal);
      currentMatrixId = null;
      await loadMatrixList();
    } catch (err) {
      showError(err);
    } finally {
      elBtnCloseMatrix.disabled = false;
    }
  }

  // ── Event wiring ──────────────────────────────────────────────

  function bindEvents() {
    elTableBody.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-matrix-id]');
      if (!btn) return;
      handleViewMatrix(btn.dataset.matrixId);
    });

    elBtnSave.addEventListener('click', handleSaveMatrix);
    elBtnCloseMatrix.addEventListener('click', handleCloseMatrix);
  }

  // ── Init ──────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    FCOS.initPage().then(function () {
      loadUsers().then(function () {
        loadMatrixList();
      });
    });
  });

})();
