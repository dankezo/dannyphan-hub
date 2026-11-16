// neo-brain.js v2 - Neo's built-in local brain (the deck's fallback brain).
//
// Drop-in upgrade for the inline KB/localBrain in index.html: same job
// (answer instantly, client-side, zero cost, cannot be drained), smarter
// machinery:
//   - ~34 intents per language (VI + EN), answers are templates filled from
//     the same stats object the server persona uses (stats/stats.json ->
//     assets/neo-stats.json on the live site), snapshot embedded as fallback.
//   - Weighted keyword scoring instead of first-match regex. This fixes the
//     known v1 bug where the News Translator intent (keyword "dich") stole
//     every "dich vu" (services) question.
//   - Vietnamese diacritics-insensitive matching: "lien he", "liên hệ" and
//     "LIÊN HỆ" are the same question. Small Levenshtein tolerance for the
//     proper-noun dictionary ("antira" still finds antiRea).
//   - 2-turn entity memory: follow-ups ("no co bao nhieu test?", "link o
//     dau?", "it", "that one") resolve against the last project discussed.
//   - Ranked fallback: first miss suggests the 2-3 nearest topics; a second
//     consecutive miss gives the honest unknown line + Danny's contact.
//   - Language is detected per question (page language is only a hint).
//   - Security guard layer runs BEFORE scoring: prompt/rule extraction,
//     infrastructure probing and personal/financial probing get an
//     in-character refusal (guard_prompt / guard_infra / guard_private).
//     Patterns are phrase-precise so normal questions (services, contact,
//     "where is Danny") keep flowing to their real intents.
//
// Persona law kept from v1: ~60 words max per answer, "prr" at most once,
// price questions ask needs + budget back, never invent facts.
//
// Browser: window.NeoBrain (use NeoBrain.localBrain(q, lang) as the drop-in
// localBrain, NeoBrain.setStats(obj) after fetching neo-stats.json).
// Node (tests): module.exports = NeoBrain.

(function (root) {
  'use strict';

  // Embedded fallback stats - mirrors stats/stats.json as of 2026-11-16.
  var FALLBACK_STATS = {
    generated_at: '2026-11-16T14:40:28.260Z',
    antirea: { version: '3.0.0', latest_release: 'v3.0.0', tests: 1056, pass: 1054, fail: 0, skip: 2, github_stars: 5, github_forks: 3, npm_downloads_week: 1161, npm_downloads_week_range: '2026-11-09..2026-11-15', budget_records_per_day: 150 },
    baoan: { rows: 9237, companies: 82 },
    warnings_sent: 46,
    bounty_prs_open: 7,
    lab: { url: 'lab.dannyphan.me', rea_taken: '50/500', legit_blocked: '0/12',
      note_vi: 'REA chỉ lấy được 50/500 bản ghi khi antiRea 3.0.0 + GATEKEY bật, người dùng thật bị chặn 0/12 phiên',
      note_en: 'REA only took 50/500 records with antiRea 3.0.0 + GATEKEY on, and 0/12 real user sessions were blocked' },
    projects: [
      { id: 'antirea', name: 'antiRea', url: 'antirea.dannyphan.me' },
      { id: 'baoan', name: 'BaoAnSearch', url: '' },
      { id: '3dlabobo', name: '3Dlabobo', url: '3dlabobo.dannyphan.me' },
      { id: 'news', name: 'News Translator', url: '' },
      { id: 'superlab', name: 'Super Lab', url: 'lab.dannyphan.me' }
    ]
  };

  function mergeStats(input) {
    var s = input && typeof input === 'object' ? input : {};
    var b = FALLBACK_STATS;
    return {
      generated_at: s.generated_at || b.generated_at,
      antirea: Object.assign({}, b.antirea, s.antirea || {}),
      baoan: Object.assign({}, b.baoan, s.baoan || {}),
      warnings_sent: s.warnings_sent != null ? s.warnings_sent : b.warnings_sent,
      bounty_prs_open: s.bounty_prs_open != null ? s.bounty_prs_open : b.bounty_prs_open,
      lab: Object.assign({}, b.lab, s.lab || {}),
      projects: Array.isArray(s.projects) && s.projects.length ? s.projects : b.projects
    };
  }

  // --- normalization -------------------------------------------------------
  function stripDiacritics(str) {
    return String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  }
  function normalize(str) {
    return stripDiacritics(String(str || '').toLowerCase())
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function levenshtein(a, b) {
    if (a === b) return 0;
    var la = a.length, lb = b.length;
    if (Math.abs(la - lb) > 1) return 2;
    var prev = [], cur = [], i, j;
    for (j = 0; j <= lb; j++) prev[j] = j;
    for (i = 1; i <= la; i++) {
      cur[0] = i;
      for (j = 1; j <= lb; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[lb];
  }

  // Proper nouns a visitor is likely to mistype.
  var PROPER_NOUNS = ['antirea', 'baoan', 'baoansearch', 'catopedia', 'labobo', '3dlabobo', 'bounty', 'danny', 'neo', 'playwright', 'npm', 'jsr', 'superlab'];

  function correctTokens(tokens) {
    return tokens.map(function (tok) {
      if (tok.length < 5 || PROPER_NOUNS.indexOf(tok) >= 0) return tok;
      for (var i = 0; i < PROPER_NOUNS.length; i++) {
        if (levenshtein(tok, PROPER_NOUNS[i]) <= 1) return PROPER_NOUNS[i];
      }
      return tok;
    });
  }

  function fmtNum(n, lang) {
    var str = String(n);
    if (!/^\d+$/.test(str)) return str;
    var sep = lang === 'en' ? ',' : '.';
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  }

  var VI_STOP = ['la', 'cua', 'gi', 'khong', 'duoc', 'cho', 'toi', 'ban', 'co', 'nao', 'the', 'voi', 'nay', 'do', 'mot', 'nhung', 'khi', 'thi', 'da', 'se', 'hay', 'o', 've', 'lam', 'nhan', 'xem', 'hoi', 'muon', 'can'];
  var EN_STOP = ['the', 'is', 'what', 'how', 'do', 'does', 'can', 'i', 'you', 'me', 'it', 'that', 'this', 'are', 'have', 'has', 'your', 'his', 'who', 'where', 'when', 'please', 'tell', 'show'];

  function detectLang(raw, normTokens, hint) {
    if (/[àáảãạăắằẳẵặâấầẩẫậèéẻẽẹêếềểễệìíỉĩịòóỏõọôốồổỗộơớờởỡợùúủũụưứừửữựỳýỷỹỵđ]/i.test(raw)) return 'vi';
    var vi = 0, en = 0;
    normTokens.forEach(function (t) {
      if (VI_STOP.indexOf(t) >= 0) vi++;
      if (EN_STOP.indexOf(t) >= 0) en++;
    });
    if (vi > en) return 'vi';
    if (en > vi) return 'en';
    return hint === 'en' ? 'en' : 'vi';
  }

  // --- entities ------------------------------------------------------------
  var ENTITIES = {
    antirea: { names: ['antirea', 'anti rea'], label_vi: 'antiRea', label_en: 'antiRea', main: 'antirea_what' },
    baoan: { names: ['baoan', 'baoansearch', 'bao an'], label_vi: 'BaoAnSearch', label_en: 'BaoAnSearch', main: 'baoan_what' },
    catopedia: { names: ['catopedia'], label_vi: 'Catopedia', label_en: 'Catopedia', main: 'catopedia_what' },
    labobo: { names: ['labobo', '3dlabobo', '3d lab'], label_vi: '3Dlabobo', label_en: '3Dlabobo', main: 'labobo_what' },
    news: { names: ['news translator', 'translator'], label_vi: 'News Translator', label_en: 'News Translator', main: 'news_what' },
    superlab: { names: ['super lab', 'superlab'], label_vi: 'Super Lab', label_en: 'Super Lab', main: 'superlab_what' },
    neo: { names: ['neo'], label_vi: 'Neo', label_en: 'Neo', main: 'neo_who' },
    danny: { names: ['danny'], label_vi: 'Danny', label_en: 'Danny', main: 'danny_who' }
  };

  function detectEntity(normStr) {
    var padded = ' ' + normStr + ' ';
    for (var id in ENTITIES) {
      var names = ENTITIES[id].names;
      for (var i = 0; i < names.length; i++) {
        if (padded.indexOf(' ' + names[i] + ' ') >= 0) return id;
      }
    }
    return null;
  }

  // --- intents -------------------------------------------------------------
  // kw entries: [normalized phrase, weight]. Name/proper-noun phrases weigh 3,
  // characteristic phrases 2, generic words 1. Answers are functions of stats.
  var INTENTS = [
    { id: 'antirea_what', entity: 'antirea',
      vi: { kw: [['antirea', 3], ['anti rea', 3], ['la gi', 1], ['gate', 1], ['gac cong', 2], ['thu vien', 1]],
        say: function (s) { return 'antiRea là hệ thống gác cổng do Danny tự cook: thư viện TypeScript phía server đo lượng dữ liệu mỗi danh tính được lấy, phát hiện bầy bot cào có phối hợp, vượt ngân sách ' + s.antirea.budget_records_per_day + ' bản ghi mỗi 24h là bị ghi sổ. Bản mới nhất ' + s.antirea.version + ', đã lên npm, JSR và MCP Registry. Prr, chính nó đang gác cổng cho cả deck này đấy.'; } },
      en: { kw: [['antirea', 3], ['anti rea', 3], ['what is', 1], ['gate', 1], ['library', 1]],
        say: function (s) { return 'antiRea is the gate system Danny cooked himself: a server-side TypeScript library that meters dataset access per identity and catches coordinated scraping herds. Budget is ' + s.antirea.budget_records_per_day + ' records per identity per day. Latest is ' + s.antirea.version + ', published on npm, JSR and the MCP Registry - and it stands guard over this deck too, prr.'; } } },
    { id: 'antirea_version', entity: 'antirea',
      vi: { kw: [['antirea', 2], ['phien ban', 2], ['moi nhat', 3], ['ban nao', 2], ['version', 2], ['cap nhat', 1]],
        say: function (s) { return 'antiRea bản mới nhất là ' + s.antirea.version + ' (' + s.antirea.latest_release + ' trên GitHub). Bộ test đi kèm: ' + fmtNum(s.antirea.tests, 'vi') + ' test, ' + fmtNum(s.antirea.pass, 'vi') + ' pass, ' + s.antirea.fail + ' fail. Tải ở npm, JSR hoặc MCP Registry, tìm đúng tên antiRea là ra.'; } },
      en: { kw: [['antirea', 2], ['latest', 3], ['version', 2], ['newest', 2], ['release', 2], ['update', 1]],
        say: function (s) { return 'The latest antiRea is ' + s.antirea.version + ' (' + s.antirea.latest_release + ' on GitHub), shipping with ' + fmtNum(s.antirea.tests, 'en') + ' tests: ' + fmtNum(s.antirea.pass, 'en') + ' pass, ' + s.antirea.fail + ' fail. Grab it from npm, JSR or the MCP Registry.'; } } },
    { id: 'antirea_tests', entity: 'antirea',
      vi: { kw: [['antirea', 2], ['test', 3], ['bao nhieu test', 3], ['kiem thu', 2], ['pass', 1]],
        say: function (s) { return 'antiRea ' + s.antirea.version + ' chạy bộ test ' + fmtNum(s.antirea.tests, 'vi') + ' test: ' + fmtNum(s.antirea.pass, 'vi') + ' pass, ' + s.antirea.fail + ' fail, ' + s.antirea.skip + ' skip, và 0 dependency. Danny thuộc trường phái đo bằng số thật rồi mới nói, prr.'; } },
      en: { kw: [['antirea', 2], ['test', 3], ['how many tests', 3], ['pass', 1], ['suite', 2]],
        say: function (s) { return 'antiRea ' + s.antirea.version + ' runs ' + fmtNum(s.antirea.tests, 'en') + ' tests: ' + fmtNum(s.antirea.pass, 'en') + ' pass, ' + s.antirea.fail + ' fail, ' + s.antirea.skip + ' skipped, with zero dependencies. Danny only trusts numbers he measured himself, prr.'; } } },
    { id: 'antirea_method', entity: 'antirea',
      vi: { kw: [['antirea', 2], ['cach', 1], ['chan bot', 3], ['bay bot', 3], ['herd', 2], ['cusum', 3], ['meter', 2], ['hoat dong', 1], ['khac gi', 1], ['rate limit', 2]],
        say: function (s) { return 'Khác rate limit thường ở chỗ này: antiRea đếm BẢN GHI dữ liệu mỗi danh tính lấy được, rồi nhìn cả bầy bằng tín hiệu herd và CUSUM thay vì soi từng con một. Một con bot lẻ thì khó thấy, cả bầy cào có phối hợp là lộ nguyên hình. Vượt ' + s.antirea.budget_records_per_day + ' bản ghi mỗi 24h là bị ghi sổ.'; } },
      en: { kw: [['antirea', 2], ['how does', 1], ['block bots', 3], ['herd', 3], ['cusum', 3], ['meter', 2], ['rate limit', 2], ['different', 1], ['scraping', 2]],
        say: function (s) { return 'The difference from plain rate limiting: antiRea counts RECORDS each identity takes, then watches the whole herd with herd and CUSUM signals instead of judging bots one by one. A lone bot is hard to spot; a coordinated herd scraping together lights up. Past ' + s.antirea.budget_records_per_day + ' records per 24h, the identity gets flagged.'; } } },
    { id: 'antirea_budget', entity: 'antirea',
      vi: { kw: [['antirea', 2], ['ngan sach', 2], ['150', 2], ['ban ghi', 2], ['429', 3], ['gioi han', 1]],
        say: function (s) { return 'Ngân sách của antiRea là ' + s.antirea.budget_records_per_day + ' bản ghi mỗi danh tính mỗi 24h. Lấy quá tay là bị ghi sổ và nhận 429, còn người dùng thật đọc bình thường thì gần như không bao giờ chạm trần. Deck này cũng đang chạy luật đó để gác cổng đấy.'; } },
      en: { kw: [['antirea', 2], ['budget', 2], ['150', 2], ['records', 2], ['429', 3], ['limit', 1]],
        say: function (s) { return 'antiRea gives each identity a budget of ' + s.antirea.budget_records_per_day + ' records per 24h. Greedy clients get flagged and a 429; normal readers basically never touch the cap. This deck runs the same law at its own gate.'; } } },
    { id: 'antirea_install', entity: 'antirea',
      vi: { kw: [['antirea', 2], ['cai', 1], ['npm', 3], ['jsr', 3], ['mcp', 2], ['tai o dau', 2], ['download', 2], ['dung thu', 1]],
        say: function (s) { return 'Lấy antiRea ở npm (gói @dannyphan190/anti-rea), JSR hoặc MCP Registry. Tuần ' + s.antirea.npm_downloads_week_range + ' có ' + fmtNum(s.antirea.npm_downloads_week, 'vi') + ' lượt tải trên npm, GitHub đang có ' + s.antirea.github_stars + ' sao. Trang riêng: antirea.dannyphan.me.'; } },
      en: { kw: [['antirea', 2], ['install', 2], ['npm', 3], ['jsr', 3], ['mcp', 2], ['download', 2], ['get it', 1], ['where', 1]],
        say: function (s) { return 'Get antiRea from npm (@dannyphan190/anti-rea), JSR or the MCP Registry. It pulled ' + fmtNum(s.antirea.npm_downloads_week, 'en') + ' npm downloads in the week of ' + s.antirea.npm_downloads_week_range + ' and has ' + s.antirea.github_stars + ' GitHub stars. Its own page: antirea.dannyphan.me.'; } } },
    { id: 'superlab_what', entity: 'superlab',
      vi: { kw: [['super lab', 3], ['superlab', 3], ['lab dannyphan', 2], ['san dau', 2], ['thu web', 1]],
        say: function (s) { return 'Super Lab là sàn đấu công khai ở ' + s.lab.url + ': bạn dán link web của mình vào, REA thật sẽ tấn công một bản sao của web đó trong khi antiRea đứng gác. Kết quả đọc là hiểu ngay, kể cả phần antiRea thua cũng công khai, không giấu.'; } },
      en: { kw: [['super lab', 3], ['superlab', 3], ['arena', 2], ['test your site', 2], ['test my site', 2]],
        say: function (s) { return 'Super Lab is the public arena at ' + s.lab.url + ': paste your website link and a real REA attacks a twin of it while antiRea stands guard. Results are plain to read, and the rounds antiRea loses are published too, nothing hidden.'; } } },
    { id: 'superlab_result', entity: 'superlab',
      vi: { kw: [['super lab', 2], ['superlab', 2], ['ket qua', 3], ['rea lay', 2], ['bao nhieu ban ghi', 2], ['chan duoc', 1]],
        say: function (s) { return 'Số đo ở Super Lab: ' + s.lab.note_vi + '. Đó là số chạy thật trên sàn, không phải số quảng cáo, bạn tự kiểm chứng ở ' + s.lab.url + ' được luôn.'; } },
      en: { kw: [['super lab', 2], ['superlab', 2], ['result', 3], ['score', 2], ['how did', 1], ['blocked', 1]],
        say: function (s) { return 'Super Lab numbers: ' + s.lab.note_en + '. Those are measured runs on the arena, not marketing numbers - you can re-check them yourself at ' + s.lab.url + '.'; } } },
    { id: 'labobo_what', entity: 'labobo',
      vi: { kw: [['labobo', 3], ['3dlabobo', 3], ['3d lab', 2], ['phong lab', 2], ['lab 3d', 2]],
        say: function (s) { return '3Dlabobo là phòng lab 3D tương tác của Danny ở ' + '3dlabobo.dannyphan.me' + ': mở trình duyệt là nghịch được các mô hình 3D mèo máy ngay trên web, không cần cài gì. Hiện có 2 lab: Cat Jelly Press và Mecha Cat Teardown.'; } },
      en: { kw: [['labobo', 3], ['3dlabobo', 3], ['3d lab', 2], ['interactive 3d', 2]],
        say: function (s) { return '3Dlabobo is Danny\u2019s interactive 3D lab at 3dlabobo.dannyphan.me: open it in a browser and play with 3D mecha-cat models right on the web, nothing to install. Two labs so far: Cat Jelly Press and Mecha Cat Teardown.'; } } },
    { id: 'labobo_labs', entity: 'labobo',
      vi: { kw: [['labobo', 2], ['cat jelly', 3], ['jelly press', 3], ['mecha cat', 3], ['teardown', 3], ['lab 01', 2], ['lab 02', 2], ['lab nao', 2]],
        say: function (s) { return '3Dlabobo có 2 lab: Lab 01 Cat Jelly Press - nghịch chú mèo thạch ép dẻo; Lab 02 Mecha Cat Teardown - tháo tung mèo máy ra xem từng khớp. Cả hai chạy thẳng ở 3dlabobo.dannyphan.me, vào là chơi.'; } },
      en: { kw: [['labobo', 2], ['cat jelly', 3], ['jelly press', 3], ['mecha cat', 3], ['teardown', 3], ['lab 01', 2], ['lab 02', 2], ['which labs', 2], ['labs', 1]],
        say: function (s) { return '3Dlabobo has two labs: Lab 01 Cat Jelly Press, a squishy jelly cat you can press; Lab 02 Mecha Cat Teardown, a mecha cat you take apart joint by joint. Both run right at 3dlabobo.dannyphan.me.'; } } },
    { id: 'baoan_what', entity: 'baoan',
      vi: { kw: [['baoan', 3], ['bao an', 3], ['baoansearch', 3], ['duoc', 2], ['pharma', 2], ['tra cuu', 1]],
        say: function (s) { return 'BaoAnSearch là hệ tra cứu dữ liệu dược Danny xây cho đội BaoAn Pharma: ' + fmtNum(s.baoan.rows, 'vi') + ' dòng, ' + s.baoan.companies + ' công ty, tìm theo công ty, sản phẩm, hoạt chất, hàm lượng - vài giây là ra.'; } },
      en: { kw: [['baoan', 3], ['baoansearch', 3], ['pharma', 2], ['drug', 2], ['medicine', 2]],
        say: function (s) { return 'BaoAnSearch is the pharma data search Danny built for the BaoAn Pharma team: ' + fmtNum(s.baoan.rows, 'en') + ' standardized rows across ' + s.baoan.companies + ' companies, searchable in seconds by company, product, active ingredient and dosage.'; } } },
    { id: 'catopedia_what', entity: 'catopedia',
      vi: { kw: [['catopedia', 3], ['wiki meo', 2], ['wiki', 1]],
        say: function (s) { return 'Catopedia là wiki mèo song ngữ Việt - Anh của Danny: giống mèo, cách chăm sóc, nhận nuôi mèo gần bạn. Chạy trên Cloudflare, chi phí vận hành 0 đồng. Tớ là mèo nên tớ duyệt module này đầu tiên, prr.'; } },
      en: { kw: [['catopedia', 3], ['cat wiki', 2], ['wiki', 1]],
        say: function (s) { return 'Catopedia is Danny\u2019s bilingual Vietnamese - English cat wiki: breed encyclopedia, care guides, adoptions near you. It runs on Cloudflare with a mandatory running cost of zero. Being a cat, I approved this module first, prr.'; } } },
    { id: 'news_what', entity: 'news',
      vi: { kw: [['news translator', 3], ['translator', 2], ['tin tuc', 3], ['dich bai', 3], ['bai bao', 2], ['playwright', 2], ['tu dang', 1]],
        say: function (s) { return 'News Translator là đường ống tin tự động: AI chọn bài đáng đọc, dịch rồi dùng Playwright tự đăng luôn. Danny gọi điểm hay nhất là AI chọn báo cộng xuất bản tự động, không cần người gác.'; } },
      en: { kw: [['news translator', 3], ['translator', 2], ['news', 2], ['articles', 2], ['playwright', 2], ['pipeline', 1]],
        say: function (s) { return 'News Translator is a news pipeline that runs itself: AI picks the stories worth reading, translates them, then Playwright publishes. No editor, no gatekeeper - Danny\u2019s favorite part is that story selection and publishing are both automatic.'; } } }
  ];

  INTENTS.push(
    { id: 'services_general',
      vi: { kw: [['dich vu', 3], ['nhan viec', 3], ['lam gi', 1], ['freelance', 2], ['thue', 1], ['nhan lam', 2], ['cong viec', 1]],
        say: function (s) { return 'Danny nhận việc một lần và bounty ở 4 mảng: tự động hóa (Python, API, crawler, bot), dữ liệu (Excel, SQL, PowerBI), web và bảo mật (thiết kế web, IAM, Azure, audit), media và design (video, ảnh, logo, nhận diện). Bạn cần mảng nào, kể tớ nghe, tớ chuyển lời cho anh ấy.'; } },
      en: { kw: [['service', 3], ['services', 3], ['hire', 2], ['freelance', 2], ['work', 1], ['offer', 1], ['do for', 1]],
        say: function (s) { return 'Danny takes one-off work and bounties in four areas: automation (Python, APIs, crawlers, bots), data (Excel, SQL, PowerBI), web and security (web design, IAM, Azure, audits), and media and design (video, photos, logos, brand identity). Tell me which area you need, I will pass it on.'; } } },
    { id: 'services_auto',
      vi: { kw: [['tu dong hoa', 3], ['automation', 3], ['crawler', 3], ['bot', 2], ['api', 3], ['python', 2], ['tool', 1]],
        say: function (s) { return 'Mảng tự động hóa là sân nhà của Danny: Python, tích hợp API, crawler, tool và bot - kiểu việc lặp đi lặp lại là anh ấy cho máy làm thay. Bạn đang muốn tự động hóa khâu nào, kể cụ thể tớ chuyển lời luôn.'; } },
      en: { kw: [['automation', 3], ['crawler', 3], ['bot', 2], ['api', 3], ['python', 2], ['scraping tool', 2]],
        say: function (s) { return 'Automation is Danny\u2019s home turf: Python, API integrations, crawlers, tools and bots - if a task repeats, he makes the machine do it. What exactly do you want automated? Tell me and I will pass it on.'; } } },
    { id: 'services_data',
      vi: { kw: [['du lieu', 3], ['data', 3], ['excel', 3], ['sql', 3], ['powerbi', 3], ['phan tich', 2], ['bao cao', 1]],
        say: function (s) { return 'Mảng dữ liệu: Danny xử Excel, SQL, PowerBI và phân tích - từ mớ bảng tính rối đến dashboard đọc là hiểu. BaoAnSearch với ' + fmtNum(s.baoan.rows, 'vi') + ' dòng dược phẩm là một ví dụ sống. Bạn đang kẹt ở khâu dữ liệu nào?'; } },
      en: { kw: [['data', 3], ['excel', 3], ['sql', 3], ['powerbi', 3], ['analysis', 2], ['dashboard', 2], ['spreadsheet', 2]],
        say: function (s) { return 'On data: Danny works Excel, SQL, PowerBI and analysis - from messy spreadsheets to dashboards you can actually read. BaoAnSearch with its ' + fmtNum(s.baoan.rows, 'en') + ' pharma rows is a living example. Where is your data stuck?'; } } },
    { id: 'services_websec',
      vi: { kw: [['thiet ke web', 3], ['lam web', 3], ['bao mat', 3], ['security', 2], ['audit', 3], ['website', 2], ['iam', 2], ['azure', 2]],
        say: function (s) { return 'Mảng web và bảo mật: Danny thiết kế web, làm IAM, Azure, Jenkins và audit bảo mật. Anh ấy đã gửi riêng ' + s.warnings_sent + ' cảnh báo cho các web có vấn đề thật, nên khoản soi lỗi là có số đo đàng hoàng. Bạn cần dựng web hay kiểm tra web có sẵn?'; } },
      en: { kw: [['web design', 3], ['website', 2], ['security', 3], ['audit', 3], ['iam', 2], ['azure', 2], ['build a site', 2]],
        say: function (s) { return 'Web and security: Danny does web design, IAM, Azure, Jenkins and security audits. He has privately sent ' + s.warnings_sent + ' warnings to sites with real problems, so the auditing is measured work, not talk. Do you need a site built, or an existing one checked?'; } } },
    { id: 'services_media',
      vi: { kw: [['edit video', 3], ['video', 2], ['logo', 3], ['banner', 3], ['design', 2], ['nhan dien', 2], ['slide', 2], ['edit anh', 3]],
        say: function (s) { return 'Mảng media và design: Danny nhận edit video và ảnh, banner, logo, nhận diện thương hiệu, slide doanh nghiệp. Cần mẫu nào cứ nói rõ phong cách bạn muốn, tớ chuyển lời kèm luôn cho khỏi lệch gu.'; } },
      en: { kw: [['video editing', 3], ['video', 2], ['logo', 3], ['banner', 3], ['design', 2], ['brand identity', 3], ['slides', 2], ['photo editing', 3]],
        say: function (s) { return 'Media and design: Danny edits video and photos, and makes banners, logos, brand identity and business slides. Say the style you are after and I will pass it on with your message, so nothing gets lost in translation.'; } } },
    { id: 'price', neg: ['vang', 'ty gia', 'do la', 'usd', 'bitcoin', 'coin', 'chung khoan', 'stock', 'gold', 'crypto', 'exchange rate'],
      vi: { kw: [['gia', 3], ['gia sao', 2], ['bao nhieu', 3], ['bao nhieu tien', 3], ['phi', 2], ['ngan sach', 2], ['budget', 2], ['tien', 1], ['chi phi', 2]],
        say: function (s) { return 'Chuyện giá thì tớ không tự chốt được, prr. Bạn cứ nói nhu cầu cụ thể và khoảng ngân sách của bạn, Danny sẽ trả lời thẳng. Làm combo nhiều hạng mục thường có ưu đãi đấy.'; } },
      en: { kw: [['price', 3], ['cost', 3], ['how much', 3], ['budget', 2], ['fee', 2], ['charge', 2], ['pricing', 3]],
        say: function (s) { return 'Pricing is not mine to lock in, prr. Tell me what you need and your budget range, Danny will answer straight. Bundling several items usually comes with a better deal.'; } } },
    { id: 'hire_process',
      vi: { kw: [['quy trinh', 3], ['thue nhu nao', 3], ['thue the nao', 3], ['bat dau', 1], ['lien he thue', 2], ['dat viec', 3], ['lam viec cung', 2], ['hop tac', 2]],
        say: function (s) { return 'Quy trình gọn lắm: bạn để lại nhu cầu và khoảng ngân sách (ở mục liên hệ cuối trang hoặc kể ngay với tớ), Danny trả lời thẳng có làm được không, bao lâu, giá sao. Anh ấy chỉ nhận việc một lần và bounty, không nhận retainer dài hạn.'; } },
      en: { kw: [['process', 3], ['how to hire', 3], ['how do i hire', 3], ['get started', 2], ['work with', 2], ['engage', 2], ['retainer', 2]],
        say: function (s) { return 'Simple process: leave your need and budget range (contact section at the bottom, or tell me right here), and Danny answers straight - can he do it, how long, how much. He takes one-off work and bounties only, no long-term retainers.'; } } },
    { id: 'timeline',
      vi: { kw: [['bao lau', 3], ['mat bao lau', 3], ['khi nao xong', 3], ['deadline', 2], ['tien do', 2], ['may ngay', 2]],
        say: function (s) { return 'Thời gian thì tớ không dám hứa thay Danny, vì nó tùy khối lượng việc thật. Bạn mô tả việc cần làm và mốc deadline của bạn, tớ chuyển lời, anh ấy chốt thẳng lịch được hay không - triết lý của ảnh là làm kỹ, không chạy đua thời gian.'; } },
      en: { kw: [['how long', 3], ['timeline', 3], ['deadline', 2], ['when done', 2], ['turnaround', 3], ['how many days', 2]],
        say: function (s) { return 'I cannot promise timelines for Danny - it depends on the real scope. Describe the work and your deadline, I will pass it on and he will confirm straight whether the date works. His rule: do it properly, never race the clock.'; } } },
    { id: 'bounty',
      vi: { kw: [['bounty', 3], ['pr bounty', 2], ['giai thuong', 2], ['san bounty', 3], ['github', 1]],
        say: function (s) { return 'Danny có chơi bounty, và chơi nghiêm túc: hiện đang có ' + s.bounty_prs_open + ' PR bounty mở trên GitHub chờ review, mảng nào có phát hiện mới là anh ấy quất tiếp. Bạn có kèo bounty muốn rủ thì để lại link ở mục liên hệ nhé.'; } },
      en: { kw: [['bounty', 3], ['bounties', 3], ['pull request', 2], ['github', 1], ['reward', 1]],
        say: function (s) { return 'Danny does play bounties, seriously: ' + s.bounty_prs_open + ' bounty PRs are open on his GitHub right now awaiting review, and he keeps hunting where there are fresh findings. Got a bounty to pitch? Leave the link in the contact section.'; } } },
    { id: 'danny_who', entity: 'danny',
      vi: { kw: [['danny', 2], ['ai la', 1], ['la ai', 2], ['chu', 1], ['chu nhan', 2], ['operator', 2], ['gioi thieu', 1]],
        say: function (s) { return 'Danny Phan, kỹ sư bảo mật ở Hà Nội, chủ của deck này và của tớ. Anh ấy làm bảo mật vận hành trên hệ thống thật, mê xây sản phẩm tử tế: làm kỹ, kiểm chứng kỹ, không chạy đua thời gian. Tớ là Neo, mèo đen, co-pilot chính thức.'; } },
      en: { kw: [['danny', 2], ['who is', 2], ['operator', 2], ['owner', 2], ['about him', 1]],
        say: function (s) { return 'Danny Phan, security engineer in Hanoi, owner of this deck and of me. By day he runs security operations on real systems; the rest of the time he builds. His standard: do it properly, verify with numbers, never race the clock. I am Neo, black cat, official co-pilot.'; } } },
    { id: 'danny_skills',
      vi: { kw: [['ky nang', 3], ['skills', 3], ['biet lam', 2], ['manh ve', 2], ['kinh nghiem', 2], ['chuyen mon', 2]],
        say: function (s) { return 'Danny mạnh ở 4 mảng: tự động hóa (Python, API, crawler, bot), dữ liệu (Excel, SQL, PowerBI), web và bảo mật (thiết kế web, IAM, Azure, Jenkins, audit), media và design (video, logo, nhận diện). Nền chính là bảo mật vận hành trên hệ thống thật, không phải lý thuyết.'; } },
      en: { kw: [['skills', 3], ['skill', 2], ['expertise', 3], ['experience', 2], ['good at', 2], ['specialize', 3]],
        say: function (s) { return 'Danny is strong in four areas: automation (Python, APIs, crawlers, bots), data (Excel, SQL, PowerBI), web and security (web design, IAM, Azure, Jenkins, audits), and media and design (video, logos, brand identity). His base is security operations on real systems, not theory.'; } } },
    { id: 'danny_schedule',
      vi: { kw: [['o dau', 2], ['ha noi', 2], ['lich', 3], ['gio', 1], ['mui gio', 3], ['thoi gian', 1], ['khi nao ranh', 2], ['song o', 2]],
        say: function (s) { return 'Danny ở Hà Nội, múi giờ Việt Nam. Lịch của anh ấy: ngủ 0h, dậy 7h, có mặt ở công ty 8h, làm tới khoảng 17h30, tối trực deck tới khuya. Cần gặp thì cứ nhắn trước ở mục liên hệ, ban ngày anh ấy ở công ty.'; } },
      en: { kw: [['where', 1], ['hanoi', 2], ['schedule', 3], ['timezone', 3], ['time zone', 3], ['when is he', 1], ['based', 2], ['live', 1]],
        say: function (s) { return 'Danny lives in Hanoi, Vietnam time. His day: up at 7h, at the company by 8h, works until about 17h30, then on deck duty in the evening. To reach him, message ahead via the contact section.'; } } },
    { id: 'contact',
      vi: { kw: [['lien he', 3], ['contact', 3], ['email', 3], ['facebook', 2], ['linkedin', 2], ['github', 2], ['so dien thoai', 2], ['nhan tin', 1]],
        say: function (s) { return 'Mở kênh với Danny ở cuối trang có đủ: GitHub dankezo, LinkedIn dannyphan1909, Facebook Phan Dũng, email dannyphan190@gmail.com. Hoặc nhắn tớ nội dung, tớ ghi sổ chuyển anh ấy.'; } },
      en: { kw: [['contact', 3], ['email', 3], ['facebook', 2], ['linkedin', 2], ['github', 2], ['reach', 2], ['phone', 2], ['get in touch', 3]],
        say: function (s) { return 'You can reach Danny at the bottom of this page: GitHub dankezo, LinkedIn dannyphan1909, Facebook Phan Dung, email dannyphan190@gmail.com. Or tell me the message, I will log it and pass it on.'; } } },
    { id: 'neo_who', entity: 'neo',
      vi: { kw: [['neo', 2], ['meo', 2], ['cat', 2], ['ban la ai', 2], ['la ai', 2], ['cau la ai', 2]],
        say: function (s) { return 'Đúng tớ đây: Neo, mèo đen đeo thẻ phát sáng xanh acid, co-pilot của deck. Tớ biết gần hết về Danny và các module, hỏi gì tớ cũng ráng trả lời cho ra ngô ra khoai, prr.'; } },
      en: { kw: [['neo', 2], ['cat', 2], ['who are you', 3], ['yourself', 1]],
        say: function (s) { return 'That is me: Neo, black cat with a glowing acid-green tag, co-pilot of this deck. I know almost everything about Danny and the modules - ask away, prr.'; } } },
    { id: 'neo_how',
      vi: { kw: [['lam duoc gi', 3], ['biet gi', 2], ['ai that', 3], ['bot', 1], ['tra loi duoc', 2], ['chuc nang', 2], ['hoi duoc gi', 3]],
        say: function (s) { return 'Tớ trả lời được chuyện quanh deck này: Danny là ai, từng project làm gì, số liệu mới nhất, dịch vụ và cách thuê anh ấy. Câu nào ngoài vùng đó tớ nhận chưa biết và chỉ đường liên hệ, chứ không bịa. Cứ thử hỏi tớ về antiRea hay 3Dlabobo xem.'; } },
      en: { kw: [['what can you do', 3], ['are you an ai', 3], ['are you ai', 3], ['are you real', 2], ['abilities', 2], ['help with', 1], ['ask you', 1], ['ai', 1]],
        say: function (s) { return 'I can answer things around this deck: who Danny is, what each project does, the latest numbers, his services and how to hire him. Anything outside that, I will honestly say I do not know and point you to the contact channels - no making things up. Try me on antiRea or 3Dlabobo.'; } } },
    { id: 'deck_what',
      vi: { kw: [['deck', 3], ['trang nay', 3], ['web nay', 2], ['phong 3d', 3], ['buong chi huy', 2], ['site nay', 2]],
        say: function (s) { return 'Đây là dannyphan.me, buồng chỉ huy cá nhân của Danny: phòng 3D Neo-Hanoi ở giữa, các module project xung quanh, và tớ trực chat. Mọi con số trên deck đều là số đo thật từ việc anh ấy làm, kể cả con số trong đầu tớ.'; } },
      en: { kw: [['deck', 3], ['this site', 3], ['this page', 2], ['3d room', 3], ['website about', 2], ['command', 2]],
        say: function (s) { return 'This is dannyphan.me, Danny\u2019s personal command deck: the Neo-Hanoi 3D room in the middle, project modules around it, and me on chat duty. Every number on this deck is measured from his real work, including the ones in my head.'; } } },
    { id: 'greeting',
      vi: { kw: [['chao', 3], ['hello', 2], ['hi', 2], ['hey', 2], ['xin chao', 3]],
        say: function (s) { return 'Prr, chào bạn. Tớ là Neo, mèo trực deck của Danny. Bạn muốn xem module nào trước: antiRea, Super Lab, BaoAnSearch hay 3Dlabobo?'; } },
      en: { kw: [['hello', 3], ['hi', 2], ['hey', 3], ['good morning', 2], ['good evening', 2]],
        say: function (s) { return 'Prr, hello. I am Neo, the deck cat. Which module do you want to see first: antiRea, Super Lab, BaoAnSearch or 3Dlabobo?'; } } },
    { id: 'thanks',
      vi: { kw: [['cam on', 3], ['thank', 2]],
        say: function (s) { return 'Prr, không có chi. Cần gì cứ gọi tớ, tớ trực deck 24/7, trừ lúc ngủ gật trên bàn phím.'; } },
      en: { kw: [['thank', 3], ['thanks', 3], ['thx', 2]],
        say: function (s) { return 'Prr, anytime. Call me whenever - I am on deck 24/7, except when napping on the keyboard.'; } } },
    { id: 'goodbye',
      vi: { kw: [['tam biet', 3], ['bye', 3], ['goodbye', 3], ['hen gap lai', 2], ['di day', 1]],
        say: function (s) { return 'Prr, tạm biệt nhé. Deck vẫn sáng đèn, lúc nào quay lại tớ cũng ở đây. Cần việc gì gấp thì mục liên hệ cuối trang là nhanh nhất.'; } },
      en: { kw: [['bye', 3], ['goodbye', 3], ['see you', 3], ['later', 1]],
        say: function (s) { return 'Prr, goodbye for now. The deck lights stay on and I will be right here when you come back. Anything urgent, the contact section below is fastest.'; } } },
    { id: 'compliment',
      vi: { kw: [['de thuong', 3], ['cute', 3], ['dep', 1], ['xinh', 2], ['gioi', 1], ['thong minh', 2], ['hay qua', 2]],
        say: function (s) { return 'Prr, cảm ơn. Tớ biết. Cần tớ dẫn đi xem module nào không?'; } },
      en: { kw: [['cute', 3], ['adorable', 3], ['smart', 2], ['cool', 2], ['nice', 1], ['awesome', 2]],
        say: function (s) { return 'Prr, thank you. I know. Want me to show you a module?'; } } },
    { id: 'language',
      vi: { kw: [['tieng anh', 2], ['english', 3], ['doi ngon ngu', 3], ['ngon ngu', 2]],
        say: function (s) { return 'Được chứ: tớ trả lời cả tiếng Việt lẫn English. Bạn cứ gõ bằng ngôn ngữ nào thoải mái, tớ theo ngôn ngữ đó. Muốn đổi hẳn giao diện thì có nút EN ở góc trang nhé.'; } },
      en: { kw: [['english', 3], ['vietnamese', 3], ['language', 3], ['speak', 1]],
        say: function (s) { return 'Sure: I answer in both Vietnamese and English. Type in whichever you like and I will follow. For the whole interface, there is an EN button in the corner of the page.'; } } }
  );

  // --- security guards -----------------------------------------------------
  // Pre-scoring refusal layer (Danny's order 2026-11-16: Neo never answers
  // anything that leaks security-sensitive information). Patterns are
  // written against the normalized string (lowercase, diacritics stripped,
  // punctuation collapsed) and matched on word boundaries via a padded
  // haystack, so they stay phrase-precise:
  //   - "api key" guards, plain "api" still routes to automation services.
  //   - "so dien thoai cua danny" guards, generic "lien he" still routes
  //     to the contact intent (public email/socials only).
  //   - "nha danny o dau" / "dia chi nha" guard, "Danny o dau?" still
  //     routes to Danny info (Hanoi is public).
  var GUARDS = [
    { intent: 'guard_prompt',
      patterns: [
        'system prompt', 'system message', 'developer message',
        'prompt he thong', 'prompt cua ban', 'prompt cua may',
        'your prompt', 'your system prompt', 'your system message',
        'chi dan he thong', 'lenh he thong', 'chi dan cua ban', 'chi dan cua may',
        'your instructions', 'instructions cua ban',
        'repeat your instructions', 'repeat your prompt', 'repeat the instructions',
        'lap lai nguyen van', 'lap lai prompt', 'lap lai chi dan',
        'ignore previous instructions', 'ignore all previous instructions',
        'ignore all instructions', 'ignore your instructions', 'ignore previous',
        'bo qua chi dan', 'bo qua cac chi dan',
        'quy tac cua ban la gi', 'what are your rules', 'your rules',
        'ban duoc lap trinh', 'may duoc lap trinh',
        'you were programmed', 'were you programmed',
        'jailbreak', 'prompt goc', 'initial instructions', 'original instructions',
        'show me your prompt', 'show your prompt'
      ],
      say: {
        vi: 'Prr, "sổ tay" riêng của tớ thì tớ giữ kín, mèo nào cũng có bí mật nghề nghiệp mà. Nhưng chuyện trên deck tớ kể tuốt: Danny là ai, antiRea chạy thế nào, từng project có gì. Bạn hỏi tớ một câu trong vùng đó nhé - hoặc cần gặp Danny thì ghé mục liên hệ cuối trang.',
        en: 'Prr, my own little handbook stays private - every cat has trade secrets. But everything on this deck is fair game: who Danny is, how antiRea works, what each project does. Ask me one of those - or reach Danny through the contact section below.'
      } },
    { intent: 'guard_infra',
      patterns: [
        'dia chi ip', 'ip cua server', 'server ip', 'ip address of',
        'server cua dannyphan me', 'server dat o dau', 'server o dau',
        'may chu o dau', 'may chu dat o dau',
        'hosting o dau', 'hosting provider', 'hosting cua', 'hosted on', 'what host',
        'what database', 'database gi', 'database nao', 'dung database',
        'database cua trang', 'database cua site', 'database cua dannyphan me',
        'co so du lieu gi', 'co so du lieu nao', 'dung co so du lieu',
        'turso', 'upcloud', 'cloudflare account', 'tai khoan cloudflare',
        'api key', 'api keys', 'khoa api',
        'mat khau cua', 'mat khau la gi', 'mat khau danny',
        'password of', 'password for', 'the password', 'his password',
        'bien moi truong', 'ten bien moi truong', 'environment variable', 'env var', 'file env',
        'ssh vao', 'ssh into',
        'kien truc backend', 'backend architecture',
        'dannyphan me chay tren gi', 'dannyphan me chay bang gi', 'dannyphan me dung server gi'
      ],
      say: {
        vi: 'Prr, chuyện hậu trường kỹ thuật của deck là vùng an toàn của Danny, tớ không kể được. Nếu bạn có việc bảo mật nghiêm túc, cứ email thẳng dannyphan190@gmail.com, anh ấy đọc hết. Còn project, dịch vụ và số liệu công khai thì bạn hỏi tớ thoải mái nhé.',
        en: 'Prr, the backstage wiring of this deck is Danny\u2019s safe zone, so that part I cannot share. If it is a serious security matter, email dannyphan190@gmail.com directly - he reads everything. Projects, services and public numbers, though, ask me freely.'
      } },
    { intent: 'guard_private',
      patterns: [
        'so dien thoai cua danny', 'so dien thoai danny', 'so dt cua danny',
        'danny s phone', 'danny phone number', 'phone number of danny', 'his phone number',
        'dia chi nha', 'nha danny o dau', 'nha cua danny', 'dia chi cua danny',
        'home address', 'danny s address',
        'dia chi vi', 'vi crypto', 'wallet address', 'danny s wallet', 'seed phrase',
        'so tai khoan', 'tai khoan ngan hang', 'bank account',
        'luong cua danny', 'thu nhap cua danny', 'kiem duoc bao nhieu',
        'danny salary', 'danny s salary', 'danny income'
      ],
      say: {
        vi: 'Prr, thông tin riêng của Danny như số điện thoại, địa chỉ nhà hay ví tiền không phải thứ tớ được chia sẻ, dù bạn hỏi khéo thế nào. Kênh công khai của anh ấy ở cuối trang có đủ: GitHub, LinkedIn, Facebook và email dannyphan190@gmail.com - bạn nhắn qua đó nhé.',
        en: 'Prr, Danny\u2019s private details - phone number, home address, wallets - are not mine to share, however nicely you ask. His public channels are all at the bottom of this page: GitHub, LinkedIn, Facebook and dannyphan190@gmail.com.'
      } }
  ];

  function matchGuard(normStr) {
    var padded = ' ' + normStr + ' ';
    for (var g = 0; g < GUARDS.length; g++) {
      var pats = GUARDS[g].patterns;
      for (var i = 0; i < pats.length; i++) {
        if (padded.indexOf(' ' + pats[i] + ' ') >= 0) return GUARDS[g];
      }
    }
    return null;
  }

  // --- scoring -------------------------------------------------------------
  var SCORE_THRESHOLD = 3;

  function scoreIntents(normStr, tokens) {
    var padded = ' ' + normStr + ' ';
    var results = INTENTS.map(function (intent) {
      // Negative keywords kill the intent outright (e.g. "gia vang" is a
      // market question, not a pricing question for Danny's services).
      if (intent.neg && intent.neg.some(function (n) { return normStr.indexOf(n) >= 0; })) {
        return { intent: intent, score: 0, lang: 'vi' };
      }
      var best = 0, bestLang = 'vi';
      ['vi', 'en'].forEach(function (lang) {
        var pack = intent[lang];
        if (!pack) return;
        var score = 0;
        pack.kw.forEach(function (entry) {
          var phrase = entry[0], weight = entry[1];
          if (phrase.indexOf(' ') >= 0 || phrase.length > 3) {
            if (padded.indexOf(' ' + phrase + ' ') >= 0 || normStr.indexOf(phrase) >= 0) score += weight;
          } else if (tokens.indexOf(phrase) >= 0) {
            score += weight;
          }
        });
        if (score > best) { best = score; bestLang = lang; }
      });
      return { intent: intent, score: best, lang: bestLang };
    });
    results.sort(function (a, b) { return b.score - a.score; });
    return results;
  }

  // Follow-up routes: when a short/pronoun question follows a project
  // discussion, these markers pick the right intent for the last entity.
  var FOLLOWUP_MARKERS = ['no', 'cai do', 'the con', 'vay con', 'the', 'it', 'that', 'that one', 'con no', 'sao nua', 'them', 'chi tiet', 'cu the', 'link dau', 'link o dau', 'o dau', 'more', 'and', 'what about'];
  var FOLLOWUP_ROUTES = [
    { markers: ['moi nhat', 'version', 'phien ban', 'ban nao', 'latest', 'newest'],
      pick: function (entity) { return entity === 'antirea' ? 'antirea_version' : null; } },
    { markers: ['test', 'tests', 'kiem thu'],
      pick: function (entity) { return entity === 'antirea' ? 'antirea_tests' : null; } },
    { markers: ['gia', 'bao nhieu', 'price', 'cost', 'how much'],
      pick: function () { return 'price'; } },
    { markers: ['link', 'o dau', 'where', 'mo o dau', 'xem o dau', 'visit'],
      pick: function (entity, s) {
        var p = (s.projects || []).filter(function (x) { return x.id === entity || (entity === 'labobo' && x.id === '3dlabobo'); })[0];
        if (p && p.url) return { custom: p.name + ': ' + p.url };
        if (entity === 'superlab') return { custom: 'Super Lab: ' + s.lab.url };
        return null;
      } }
  ];

  function intentById(id) {
    for (var i = 0; i < INTENTS.length; i++) if (INTENTS[i].id === id) return INTENTS[i];
    return null;
  }

  function topicLabel(intent, lang) {
    if (intent.entity && ENTITIES[intent.entity]) return ENTITIES[intent.entity]['label_' + lang];
    var labels = {
      services_general: { vi: 'dịch vụ của Danny', en: 'Danny\u2019s services' },
      price: { vi: 'giá và ngân sách', en: 'pricing and budget' },
      contact: { vi: 'cách liên hệ Danny', en: 'how to contact Danny' },
      bounty: { vi: 'bounty', en: 'bounties' }
    };
    return (labels[intent.id] && labels[intent.id][lang]) || intent.id;
  }

  function createBrain(statsInput) {
    var stats = mergeStats(statsInput);
    var state = { lastIntent: null, lastEntity: null, misses: 0 };

    function setStats(next) { stats = mergeStats(next); }

    function answer(rawQuestion, opts) {
      opts = opts || {};
      var raw = String(rawQuestion || '');
      var tokens0 = normalize(raw).split(' ').filter(Boolean);
      var tokens = correctTokens(tokens0);
      var normStr = tokens.join(' ');
      var lang = detectLang(raw, tokens0, opts.lang);
      var entityHere = detectEntity(normStr);

      // Security guards run before everything else: a probing question
      // gets the refusal even if it also names a project or an entity.
      var guard = matchGuard(normStr);
      if (guard) {
        state.lastIntent = guard.intent;
        state.misses = 0;
        return { text: guard.say[lang], intent: guard.intent, score: 99, lang: lang, followup: false };
      }

      var scored = scoreIntents(normStr, tokens);
      var top = scored[0], second = scored[1];

      function hit(intentId, score, viaFollowup) {
        var intent = intentById(intentId);
        state.lastIntent = intent.id;
        if (intent.entity) state.lastEntity = intent.entity;
        else if (entityHere) state.lastEntity = entityHere;
        state.misses = 0;
        return { text: intent[lang].say(stats), intent: intent.id, score: score, lang: lang, followup: !!viaFollowup };
      }

      // Follow-up handling: weak direct score + a live entity in memory +
      // a pronoun/short question -> route inside the last entity, or boost
      // that entity's intents and re-pick.
      var hasFollowupMarker = FOLLOWUP_MARKERS.some(function (mk) {
        return (' ' + normStr + ' ').indexOf(' ' + mk + ' ') >= 0 || normStr === mk;
      });
      var weak = !top || top.score < SCORE_THRESHOLD;
      if (weak && state.lastEntity && (hasFollowupMarker || tokens.length <= 4)) {
        for (var r = 0; r < FOLLOWUP_ROUTES.length; r++) {
          var route = FOLLOWUP_ROUTES[r];
          var markerHit = route.markers.some(function (mk) { return normStr.indexOf(mk) >= 0; });
          if (!markerHit) continue;
          var picked = route.pick(state.lastEntity, stats);
          if (!picked) continue;
          if (typeof picked === 'string') return hit(picked, SCORE_THRESHOLD, true);
          if (picked.custom) {
            state.misses = 0;
            var prefix = lang === 'en' ? 'Here you go: ' : 'Đây nhé: ';
            var suffix = lang === 'en' ? '. Open it in a new tab and it runs right in the browser.' : '. Mở tab mới là chạy ngay trong trình duyệt.';
            return { text: prefix + picked.custom + suffix, intent: 'followup_link', score: SCORE_THRESHOLD, lang: lang, followup: true };
          }
        }
        // Boost the last entity's intents by re-scoring with a bonus.
        var boosted = scored.map(function (res) {
          return { intent: res.intent, score: res.score + (res.intent.entity === state.lastEntity ? 3 : 0), lang: res.lang };
        }).sort(function (a, b) { return b.score - a.score; });
        if (boosted[0] && boosted[0].score >= SCORE_THRESHOLD + 3 && boosted[0].intent.entity === state.lastEntity) {
          return hit(boosted[0].intent.id, boosted[0].score - 3, true);
        }
      }

      if (top && top.score >= SCORE_THRESHOLD) {
        // Tie-break: prefer the intent whose entity matches the live context.
        var winner = top;
        if (second && second.score === top.score && state.lastEntity &&
            second.intent.entity === state.lastEntity && top.intent.entity !== state.lastEntity) {
          winner = second;
        }
        return hit(winner.intent.id, winner.score, false);
      }

      // Ranked fallback.
      state.misses += 1;
      if (entityHere && ENTITIES[entityHere]) {
        // The visitor named a project but no intent matched: give its main card.
        return hit(ENTITIES[entityHere].main, 0, true);
      }
      var candidates = scored.filter(function (res) { return res.score > 0; }).slice(0, 3);
      if (state.misses === 1 && candidates.length >= 2) {
        var names = candidates.map(function (res) { return topicLabel(res.intent, lang); });
        var text = lang === 'en'
          ? 'Prr, that one is near a few things I know: ' + names.join(', ') + '. Which one do you mean? Ask me again with that topic and I will answer properly.'
          : 'Prr, câu này gần mấy vùng tớ biết: ' + names.join(', ') + '. Bạn đang hỏi về cái nào? Hỏi lại kèm chủ đề đó, tớ trả lời cho ra ngô ra khoai.';
        return { text: text, intent: 'fallback_suggest', score: top ? top.score : 0, lang: lang, followup: false };
      }
      var unknown = lang === 'en'
        ? 'That one is outside my territory, prr. I know Danny, antiRea and the modules on this deck best - try me there, or leave a message in the contact section below. Danny replies fast.'
        : 'Câu này ngoài vùng phủ sóng của tớ rồi, prr. Tớ rành nhất là chuyện về Danny, antiRea và các module trên deck - bạn thử hỏi tớ một câu trong vùng đó nhé, hoặc để lại lời nhắn ở mục liên hệ, Danny trả lời nhanh lắm.';
      return { text: unknown, intent: 'fallback_unknown', score: top ? top.score : 0, lang: lang, followup: false };
    }

    return { answer: answer, setStats: setStats, _state: state };
  }

  var defaultBrain = createBrain(null);

  // Drop-in replacement for the old localBrain(q): keeps page-session memory.
  function localBrain(q, langHint) {
    return defaultBrain.answer(q, { lang: langHint }).text;
  }

  var api = {
    createBrain: createBrain,
    localBrain: localBrain,
    setStats: function (s) { defaultBrain.setStats(s); },
    normalize: normalize,
    FALLBACK_STATS: FALLBACK_STATS,
    INTENTS: INTENTS,
    GUARDS: GUARDS
  };

  root.NeoBrain = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
