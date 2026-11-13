// 首頁的產業篩選與搜尋。只處理顯示與隱藏，不產生任何內容。
(function () {
  var board = document.getElementById('board');
  if (!board) return;

  var rows = Array.prototype.slice.call(board.children);
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var input = document.getElementById('q');
  var count = document.getElementById('count');
  var empty = document.getElementById('empty');
  var reset = document.getElementById('reset');
  var industry = '';

  function apply() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (li) {
      var okIndustry = !industry || li.dataset.industry === industry;
      var okSearch = !q || li.dataset.search.indexOf(q) !== -1;
      li.hidden = !(okIndustry && okSearch);
      if (!li.hidden) shown++;
    });
    var filtered = industry || q;
    count.textContent = filtered ? '符合 ' + shown + ' 篇，共 ' + rows.length + ' 篇筆記' : '共 ' + rows.length + ' 篇筆記';
    empty.hidden = shown !== 0;
  }

  function pick(value) {
    industry = value;
    chips.forEach(function (c) {
      c.setAttribute('aria-pressed', String(c.dataset.industry === value));
    });
    apply();
  }

  chips.forEach(function (c) {
    c.addEventListener('click', function () { pick(c.dataset.industry); });
  });
  input.addEventListener('input', apply);
  reset.addEventListener('click', function () {
    input.value = '';
    pick('');
    input.focus();
  });
})();
