// Settings: the activity log's size, exporting it as a file and clearing
// it (src/shared/activity-log.js). The export is a local download made in
// this page; nothing touches the network.
(function (WKV) {
  'use strict';

  const fieldset = document.getElementById('activity-log');
  const status = fieldset.querySelector('.log-status');
  const exportButton = fieldset.querySelector('.export');
  const clearButton = fieldset.querySelector('.reset');

  const day = t => new Date(t).toISOString().slice(0, 10);

  async function render() {
    try {
      const { count, since } = await WKV.activityLog.info();
      status.textContent = count ? `${count} ${count === 1 ? 'entry' : 'entries'} since ${day(since)}` : 'empty';
      exportButton.disabled = clearButton.disabled = !count;
    } catch (err) {
      status.textContent = `can't be read: ${err?.message ?? err}`;
    }
  }

  exportButton.addEventListener('click', async () => {
    const blob = new Blob([await WKV.activityLog.toJsonl()], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `wanikani-voice-log-${day(Date.now())}.jsonl`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  });

  clearButton.addEventListener('click', async () => {
    if (!confirm('Delete the whole activity log? Export it first if you want to keep it.')) return;
    await WKV.activityLog.clear();
    render();
  });

  render();
  // New entries arrive while a review is open in another tab.
  setInterval(() => { if (!document.hidden) render(); }, 5000);
})(globalThis.WKV = globalThis.WKV || {});
