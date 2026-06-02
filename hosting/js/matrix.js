/**
 * FCOS — matrix.js
 * Batch 4C Step 2: Approval Matrix UI logic
 * Consumes: listMatrix, getMatrix, createMatrix, closeMatrix
 */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────
  let currentMatrixId = null;

  // ── DOM refs ─────────────────────────────────────────────────
  const elTableBody       = document.getElementById('matrix-table-body');
  const elCreateModal     = document.getElementById('modal-create-matrix');
  const elDetailModal     = document.getElementById('modal-matrix-detail');
  const elBtnSave         = document.getElementById('btn-save-matrix');
  const elBtnCloseMatrix  = document.getElementById('btn-close-matrix');
  const elInputName       = document.getElementById('input-matrix-name');
  const elSelectLevel1    = document.getElementById('select-level-1');
  const elSelectLevel2    = document.getElementById('select-level-2');
  const elSelectLevel3    = document.getElementById('select-level-3');
  const elDetailName      = document.getElementById('detail-matrix-name');
  const elDetailLevel1    = document.getElementById('detail-level-1');
  const elDetailLevel2    = document.getElementById('detail-level-2');
  const elDetailLevel3    = document.getElementById('detail-level-3');
  const elDetailStatus    = document.getElementById('detail-status');

  // ── Helpers ──────────────────────────────────────────────────

  function openModal(el) {
    el.classList.add('is-open');
  }

  function closeModal(el) {
    el.classList.remove('is-open');
  }

  function statusBadge(status) {
    const active = String(status).toUpperCase() === 'ACTIVE';
    const label  = active ? 'Active' : 'Inactive';
    const cls    = active ? 'badge-active' : 'badge-inactive';
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function clearCreateForm() {
    elInputName.value    = '';
    elSelectLevel1.value = '';
    elSelectLevel2.value = '';
    elSelectLevel3.value = '';
  }

  function showError(err) {
    console.error(err);
    alert(err.message || 'Operation failed');
  }

  // ── List ─────────────────────────────────────────────────────

  async function loadMatrixList() {
    try {
      const records = await listMatrix();
      renderTable(records);
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
          <td>${escapeHtml(row.name || '—')}</td>
          <td>${statusBadge(row.status || 'ACTIVE')}</td>
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

    const levels = data.levels || [];

    elDetailName.textContent   = data.name        || '—';
    elDetailLevel1.textContent = levels[0]        || '—';
    elDetailLevel2.textContent = levels[1]        || '—';
    elDetailLevel3.textContent = levels[2]        || '—';
    elDetailStatus.innerHTML   = statusBadge(data.status || 'ACTIVE');
  }

  // ── Create ────────────────────────────────────────────────────

  async function handleSaveMatrix() {
    const name   = elInputName.value.trim();
    const level1 = elSelectLevel1.value;
    const level2 = elSelectLevel2.value;
    const level3 = elSelectLevel3.value;

    if (!name || !level1 || !level2 || !level3) {
      alert('Please fill in all required fields.');
      return;
    }

    const payload = {
      name,
      levels: [level1, level2, level3],
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
    // Table: delegate View button clicks
    elTableBody.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-matrix-id]');
      if (!btn) return;
      handleViewMatrix(btn.dataset.matrixId);
    });

    // Save matrix
    elBtnSave.addEventListener('click', handleSaveMatrix);

    // Close matrix
    elBtnCloseMatrix.addEventListener('click', handleCloseMatrix);
  }

  // ── Init ──────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    bindEvents();
    FCOS.initPage().then(function () {
      loadMatrixList();
    });
  });

})();
