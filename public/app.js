const CONFIG_URL_KEY = "ledger_supabase_url";
const CONFIG_ANON_KEY = "ledger_supabase_anon_key";
const RECEIPT_BUCKET = "receipts";
const TEAM_RESERVE_FLOOR = 5000;

const state = {
  supabase: null,
  user: null,
  profile: null,
  isAdmin: false,
  selectedPeriodId: null,
  data: {
    profiles: [],
    shares: [],
    periods: [],
    capitalEntries: [],
    expenses: []
  }
};

const refs = {
  authPanel: document.getElementById("auth-panel"),
  appPanel: document.getElementById("app-panel"),
  message: document.getElementById("message"),
  loginForm: document.getElementById("login-form"),
  logoutBtn: document.getElementById("logout-btn"),
  userLabel: document.getElementById("user-label"),
  summaryCards: document.getElementById("summary-cards"),
  periodForm: document.getElementById("period-form"),
  periodRows: document.getElementById("period-rows"),
  memberRows: document.getElementById("member-rows"),
  capitalForm: document.getElementById("capital-form"),
  capitalRows: document.getElementById("capital-rows"),
  expenseForm: document.getElementById("expense-form"),
  expenseRows: document.getElementById("expense-rows"),
  settlementRows: document.getElementById("settlement-rows")
};

function safe(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function formatMoney(value) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(toNumber(value));
}

function formatPercent(value) {
  return `${(toNumber(value) * 100).toFixed(2)}%`;
}

function dateOnly(dateValue) {
  if (!dateValue) {
    return "";
  }
  return String(dateValue).slice(0, 10);
}

function showMessage(text, isError = false) {
  refs.message.hidden = false;
  refs.message.className = isError ? "message error" : "message";
  refs.message.textContent = text;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    refs.message.hidden = true;
    refs.message.textContent = "";
  }, 3600);
}

function getSupabaseConfig() {
  const savedUrl = localStorage.getItem(CONFIG_URL_KEY);
  const savedAnon = localStorage.getItem(CONFIG_ANON_KEY);

  let url = savedUrl;
  let anonKey = savedAnon;

  if (!url || !anonKey) {
    url = window.prompt("请输入 Supabase URL（形如 https://xxxx.supabase.co）", savedUrl || "") || "";
    anonKey = window.prompt("请输入 Supabase anon key", savedAnon || "") || "";
    if (!url || !anonKey) {
      return null;
    }
    localStorage.setItem(CONFIG_URL_KEY, url.trim());
    localStorage.setItem(CONFIG_ANON_KEY, anonKey.trim());
  }

  return {
    url: url.trim(),
    anonKey: anonKey.trim()
  };
}

function mergeMembers(profiles, shares) {
  const byUser = new Map();
  shares.forEach((share) => {
    byUser.set(share.user_id, {
      user_id: share.user_id,
      hashrate_ths: toNumber(share.hashrate_ths),
      is_active: Boolean(share.is_active)
    });
  });

  return profiles.map((profile) => {
    const share = byUser.get(profile.id);
    return {
      user_id: profile.id,
      display_name: profile.display_name || profile.email || profile.id,
      role: profile.role,
      hashrate_ths: share ? share.hashrate_ths : 0,
      is_active: share ? share.is_active : true
    };
  });
}

function getCurrentPeriod() {
  return state.data.periods.find((item) => item.id === state.selectedPeriodId) || null;
}

function getMembers() {
  const members = mergeMembers(state.data.profiles, state.data.shares).filter((item) => item.is_active);
  members.sort((a, b) => a.display_name.localeCompare(b.display_name, "zh-Hans-CN"));
  return members;
}

function getShareMap(members) {
  const totalHashrate = members.reduce((sum, item) => sum + toNumber(item.hashrate_ths), 0);
  const map = new Map();
  members.forEach((item) => {
    const ratio = totalHashrate > 0 ? toNumber(item.hashrate_ths) / totalHashrate : 0;
    map.set(item.user_id, ratio);
  });
  return { totalHashrate, map };
}

function inPeriod(day, period) {
  if (!period) {
    return false;
  }
  const d = dateOnly(day);
  return d >= period.start_date && d <= period.end_date;
}

function computePoolBalance() {
  const totalCapital = state.data.capitalEntries.reduce((sum, row) => sum + toNumber(row.amount), 0);
  const poolPaid = state.data.expenses
    .filter((row) => row.payment_source === "pool")
    .reduce((sum, row) => sum + toNumber(row.amount), 0);
  return totalCapital - poolPaid;
}

function computeSettlement(period) {
  const members = getMembers();
  const { totalHashrate, map } = getShareMap(members);

  if (!period) {
    return {
      rows: [],
      totals: {
        commonExpense: 0,
        personalPaid: 0,
        totalHashrate,
        totalCapital: state.data.capitalEntries.reduce((sum, row) => sum + toNumber(row.amount), 0)
      }
    };
  }

  const scopedExpenses = state.data.expenses.filter((row) => inPeriod(row.expense_date, period));
  const scopedCapital = state.data.capitalEntries.filter((row) => inPeriod(row.entry_date, period));

  const commonExpense = scopedExpenses.reduce((sum, row) => sum + toNumber(row.amount), 0);

  const rows = members.map((member) => {
    const shareRatio = map.get(member.user_id) || 0;
    const personalPaid = scopedExpenses
      .filter((row) => row.payer_id === member.user_id && row.payment_source === "personal")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const capitalInPeriod = scopedCapital
      .filter((row) => row.owner_id === member.user_id)
      .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const allocatedCost = commonExpense * shareRatio;
    const contributed = capitalInPeriod + personalPaid;
    const net = contributed - allocatedCost;

    return {
      user_id: member.user_id,
      display_name: member.display_name,
      shareRatio,
      allocatedCost,
      contributed,
      net
    };
  });

  return {
    rows,
    totals: {
      commonExpense,
      personalPaid: scopedExpenses
        .filter((row) => row.payment_source === "personal")
        .reduce((sum, row) => sum + toNumber(row.amount), 0),
      totalHashrate,
      totalCapital: scopedCapital.reduce((sum, row) => sum + toNumber(row.amount), 0)
    }
  };
}

async function initProfileForUser() {
  const sb = state.supabase;
  const user = state.user;
  if (!user) {
    return;
  }

  const { data: profile, error } = await sb
    .from("profiles")
    .select("id, display_name, role")
    .eq("id", user.id)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!profile) {
    const emailName = (user.email || "").split("@")[0] || "member";
    const { error: insertError } = await sb.from("profiles").insert({
      id: user.id,
      display_name: emailName,
      role: "member"
    });
    if (insertError) {
      throw insertError;
    }
  }

  const { data: ensuredProfile, error: ensuredError } = await sb
    .from("profiles")
    .select("id, display_name, role")
    .eq("id", user.id)
    .single();

  if (ensuredError) {
    throw ensuredError;
  }

  state.profile = ensuredProfile;
  state.isAdmin = ensuredProfile.role === "admin";
}

async function loadData() {
  const sb = state.supabase;

  const [profilesRes, sharesRes, periodsRes, capitalRes, expenseRes] = await Promise.all([
    sb.from("profiles").select("id, display_name, role").order("created_at", { ascending: true }),
    sb.from("member_shares").select("user_id, hashrate_ths, is_active"),
    sb.from("settlement_periods").select("id, title, start_date, end_date, status").order("start_date", { ascending: false }),
    sb
      .from("capital_entries")
      .select("id, owner_id, amount, entry_date, description, receipt_path, created_at")
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(200),
    sb
      .from("expenses")
      .select("id, payer_id, amount, expense_date, category, payment_source, description, receipt_path, created_at")
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300)
  ]);

  for (const res of [profilesRes, sharesRes, periodsRes, capitalRes, expenseRes]) {
    if (res.error) {
      throw res.error;
    }
  }

  state.data.profiles = profilesRes.data || [];
  state.data.shares = sharesRes.data || [];
  state.data.periods = periodsRes.data || [];
  state.data.capitalEntries = capitalRes.data || [];
  state.data.expenses = expenseRes.data || [];

  if (!state.selectedPeriodId && state.data.periods.length > 0) {
    state.selectedPeriodId = state.data.periods[0].id;
  }
  if (state.selectedPeriodId) {
    const exists = state.data.periods.some((item) => item.id === state.selectedPeriodId);
    if (!exists) {
      state.selectedPeriodId = state.data.periods[0] ? state.data.periods[0].id : null;
    }
  }
}

function ownerNameById(userId) {
  const profile = state.data.profiles.find((item) => item.id === userId);
  return profile ? profile.display_name : userId;
}

function renderSummary() {
  const period = getCurrentPeriod();
  const settlement = computeSettlement(period);
  const poolBalance = computePoolBalance();

  const cards = [
    {
      label: "当前项目备用金池",
      value: formatMoney(poolBalance),
      helper: poolBalance < TEAM_RESERVE_FLOOR ? `低于安全线 ${TEAM_RESERVE_FLOOR}` : `安全线 ${TEAM_RESERVE_FLOOR}`
    },
    {
      label: "当前结算周期",
      value: period ? safe(period.title) : "未选择",
      helper: period ? `${period.start_date} ~ ${period.end_date}` : "先创建一个周期"
    },
    {
      label: "本期公共总支出",
      value: formatMoney(settlement.totals.commonExpense),
      helper: "按机器总算力占比分摊"
    },
    {
      label: "本期入金净额",
      value: formatMoney(settlement.totals.totalCapital),
      helper: "入金为正，提回为负"
    }
  ];

  refs.summaryCards.innerHTML = cards
    .map(
      (card) => `
        <article class="card">
          <p>${card.label}</p>
          <strong>${card.value}</strong>
          <p>${card.helper}</p>
        </article>
      `
    )
    .join("");
}

function renderPeriods() {
  const rows = state.data.periods;
  refs.periodRows.innerHTML = rows
    .map((period) => {
      const selected = period.id === state.selectedPeriodId;
      const lockButton =
        state.isAdmin && period.status === "open"
          ? `<button class="btn mini warn period-lock" data-id="${period.id}">锁账</button>`
          : "";

      return `
        <tr>
          <td>${safe(period.title)}${selected ? " (当前)" : ""}</td>
          <td>${safe(period.start_date)} ~ ${safe(period.end_date)}</td>
          <td><span class="badge ${safe(period.status)}">${safe(period.status)}</span></td>
          <td>
            <div class="action-row">
              <button class="btn mini ghost period-select" data-id="${period.id}">查看</button>
              ${lockButton}
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  refs.periodRows.querySelectorAll(".period-select").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.selectedPeriodId = btn.dataset.id;
      renderAll();
    });
  });

  refs.periodRows.querySelectorAll(".period-lock").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const yes = window.confirm("锁账后该周期数据不可修改，只能新增更正记录。确认锁账？");
      if (!yes) {
        return;
      }
      try {
        const { error } = await state.supabase
          .from("settlement_periods")
          .update({ status: "locked", locked_at: new Date().toISOString() })
          .eq("id", btn.dataset.id);
        if (error) {
          throw error;
        }
        await refreshAll("周期已锁定。");
      } catch (error) {
        showMessage(error.message || "锁账失败", true);
      }
    });
  });
}

function renderMembers() {
  const members = getMembers();
  const { totalHashrate } = getShareMap(members);

  refs.memberRows.innerHTML = members
    .map((member) => {
      const ratio = totalHashrate > 0 ? member.hashrate_ths / totalHashrate : 0;
      const action = state.isAdmin
        ? `
          <div class="action-row">
            <input class="share-input" data-id="${member.user_id}" type="number" step="0.01" value="${member.hashrate_ths}" style="max-width:120px;" />
            <button class="btn mini ghost member-save" data-id="${member.user_id}">保存</button>
          </div>
        `
        : "-";

      return `
        <tr>
          <td>${safe(member.display_name)}${member.role === "admin" ? " (admin)" : ""}</td>
          <td>${formatMoney(member.hashrate_ths)}</td>
          <td>${formatPercent(ratio)}</td>
          <td>${action}</td>
        </tr>
      `;
    })
    .join("");

  refs.memberRows.querySelectorAll(".member-save").forEach((button) => {
    button.addEventListener("click", async () => {
      const input = refs.memberRows.querySelector(`.share-input[data-id="${button.dataset.id}"]`);
      const hashrate = toNumber(input ? input.value : 0);
      if (hashrate < 0) {
        showMessage("算力不能为负数", true);
        return;
      }

      try {
        const { error } = await state.supabase.from("member_shares").upsert(
          {
            user_id: button.dataset.id,
            hashrate_ths: hashrate,
            is_active: true,
            updated_at: new Date().toISOString()
          },
          { onConflict: "user_id" }
        );

        if (error) {
          throw error;
        }

        await refreshAll("成员算力已更新。");
      } catch (error) {
        showMessage(error.message || "更新算力失败", true);
      }
    });
  });
}

function canEditRow(ownerId) {
  return ownerId === state.user.id;
}

function renderCapitalRows() {
  refs.capitalRows.innerHTML = state.data.capitalEntries
    .map((row) => {
      const isOwner = canEditRow(row.owner_id);
      const ownerName = ownerNameById(row.owner_id);
      const amount = toNumber(row.amount);
      const cls = amount >= 0 ? "money-plus" : "money-minus";
      const receipt = row.receipt_path
        ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">查看</a>`
        : "-";
      const actions = isOwner
        ? `<button class="btn mini danger capital-del" data-id="${row.id}">删除</button>`
        : "-";

      return `
        <tr>
          <td>${safe(dateOnly(row.entry_date))}</td>
          <td>${safe(ownerName)}</td>
          <td class="${cls}">${formatMoney(amount)}</td>
          <td>${safe(row.description || "-")}</td>
          <td>${receipt}</td>
          <td>${actions}</td>
        </tr>
      `;
    })
    .join("");

  refs.capitalRows.querySelectorAll(".capital-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const yes = window.confirm("确认删除这条入金/提回记录？");
      if (!yes) {
        return;
      }
      try {
        const { error } = await state.supabase.from("capital_entries").delete().eq("id", btn.dataset.id);
        if (error) {
          throw error;
        }
        await refreshAll("记录已删除。");
      } catch (error) {
        showMessage(error.message || "删除失败", true);
      }
    });
  });
}

function renderExpenseRows() {
  refs.expenseRows.innerHTML = state.data.expenses
    .map((row) => {
      const isOwner = canEditRow(row.payer_id);
      const payerName = ownerNameById(row.payer_id);
      const receipt = row.receipt_path
        ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">查看</a>`
        : "-";
      const actions = isOwner
        ? `<button class="btn mini danger expense-del" data-id="${row.id}">删除</button>`
        : "-";

      return `
        <tr>
          <td>${safe(dateOnly(row.expense_date))}</td>
          <td>${safe(payerName)}</td>
          <td>${formatMoney(row.amount)}</td>
          <td>${safe(row.payment_source)}</td>
          <td>${safe(row.category)}</td>
          <td>${safe(row.description || "-")}</td>
          <td>${receipt}</td>
          <td>${actions}</td>
        </tr>
      `;
    })
    .join("");

  refs.expenseRows.querySelectorAll(".expense-del").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const yes = window.confirm("确认删除这条支出记录？");
      if (!yes) {
        return;
      }
      try {
        const { error } = await state.supabase.from("expenses").delete().eq("id", btn.dataset.id);
        if (error) {
          throw error;
        }
        await refreshAll("支出已删除。");
      } catch (error) {
        showMessage(error.message || "删除失败", true);
      }
    });
  });
}

function renderSettlement() {
  const period = getCurrentPeriod();
  const members = getMembers();
  const { map } = getShareMap(members);
  const settlement = computeSettlement(period);

  const poolBalance = computePoolBalance();

  refs.settlementRows.innerHTML = settlement.rows
    .map((row) => {
      const targetReserve = TEAM_RESERVE_FLOOR * (map.get(row.user_id) || 0);
      const shouldTopUp = Math.max(0, targetReserve - Math.max(0, row.net));
      const netClass = row.net >= 0 ? "money-plus" : "money-minus";

      return `
        <tr>
          <td>${safe(row.display_name)}</td>
          <td>${formatPercent(row.shareRatio)}</td>
          <td>${formatMoney(row.allocatedCost)}</td>
          <td>${formatMoney(row.contributed)}</td>
          <td class="${netClass}">${formatMoney(row.net)}</td>
          <td>${formatMoney(targetReserve)}</td>
          <td>${formatMoney(shouldTopUp)}</td>
        </tr>
      `;
    })
    .join("");

  if (settlement.rows.length === 0) {
    refs.settlementRows.innerHTML = `<tr><td colspan="7">请先创建成员和结算周期。</td></tr>`;
  }

  if (poolBalance < TEAM_RESERVE_FLOOR) {
    showMessage(`当前总备用金 ${formatMoney(poolBalance)}，低于安全线 ${TEAM_RESERVE_FLOOR}，建议补款。`, false);
  }
}

function bindReceiptLinks() {
  document.querySelectorAll(".receipt-open").forEach((link) => {
    link.addEventListener("click", async (event) => {
      event.preventDefault();
      const path = link.dataset.path;
      if (!path) {
        return;
      }
      try {
        const { data, error } = await state.supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, 300);
        if (error) {
          throw error;
        }
        window.open(data.signedUrl, "_blank", "noopener,noreferrer");
      } catch (error) {
        showMessage(error.message || "打开凭证失败", true);
      }
    });
  });
}

async function uploadReceipt(file) {
  if (!file) {
    return null;
  }

  const cleanName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const path = `${state.user.id}/${Date.now()}-${cleanName}`;

  const { error } = await state.supabase.storage.from(RECEIPT_BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type || undefined
  });

  if (error) {
    throw error;
  }

  return path;
}

function renderAll() {
  refs.userLabel.textContent = `${state.profile.display_name}${state.isAdmin ? " (admin)" : ""}`;
  renderSummary();
  renderPeriods();
  renderMembers();
  renderCapitalRows();
  renderExpenseRows();
  renderSettlement();
  bindReceiptLinks();
}

async function refreshAll(successMessage) {
  await loadData();
  renderAll();
  if (successMessage) {
    showMessage(successMessage);
  }
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(refs.loginForm).entries());
  try {
    const { error } = await state.supabase.auth.signInWithPassword({
      email: String(payload.email || "").trim(),
      password: String(payload.password || "")
    });
    if (error) {
      throw error;
    }
    refs.loginForm.reset();
  } catch (error) {
    showMessage(error.message || "登录失败", true);
  }
}

async function onPeriodSubmit(event) {
  event.preventDefault();
  if (!state.isAdmin) {
    showMessage("只有管理员可以新增结算周期", true);
    return;
  }

  const payload = Object.fromEntries(new FormData(refs.periodForm).entries());
  if (payload.end_date < payload.start_date) {
    showMessage("结束日期不能早于开始日期", true);
    return;
  }

  try {
    const { data, error } = await state.supabase
      .from("settlement_periods")
      .insert({
        title: String(payload.title || "").trim(),
        start_date: payload.start_date,
        end_date: payload.end_date,
        created_by: state.user.id,
        status: "open"
      })
      .select("id")
      .single();

    if (error) {
      throw error;
    }

    state.selectedPeriodId = data.id;
    refs.periodForm.reset();
    await refreshAll("结算周期已创建。");
  } catch (error) {
    showMessage(error.message || "创建周期失败", true);
  }
}

async function onCapitalSubmit(event) {
  event.preventDefault();
  const form = refs.capitalForm;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const amount = toNumber(payload.amount);
    if (amount === 0) {
      showMessage("金额不能为0", true);
      return;
    }

    const receiptFile = form.querySelector('input[name="receipt"]').files[0];
    const receiptPath = await uploadReceipt(receiptFile);

    const { error } = await state.supabase.from("capital_entries").insert({
      owner_id: state.user.id,
      amount,
      entry_date: payload.entry_date,
      description: String(payload.description || "").trim(),
      receipt_path: receiptPath
    });

    if (error) {
      throw error;
    }

    form.reset();
    await refreshAll("入金/提回记录已提交。");
  } catch (error) {
    showMessage(error.message || "提交失败", true);
  }
}

async function onExpenseSubmit(event) {
  event.preventDefault();
  const form = refs.expenseForm;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());

  try {
    const amount = toNumber(payload.amount);
    if (amount <= 0) {
      showMessage("支出金额必须大于0", true);
      return;
    }

    const receiptFile = form.querySelector('input[name="receipt"]').files[0];
    const receiptPath = await uploadReceipt(receiptFile);

    const { error } = await state.supabase.from("expenses").insert({
      payer_id: state.user.id,
      amount,
      expense_date: payload.expense_date,
      category: payload.category,
      payment_source: payload.payment_source,
      description: String(payload.description || "").trim(),
      receipt_path: receiptPath
    });

    if (error) {
      throw error;
    }

    form.reset();
    await refreshAll("支出记录已提交。");
  } catch (error) {
    showMessage(error.message || "提交失败", true);
  }
}

async function onLogout() {
  await state.supabase.auth.signOut();
}

function setAuthedUI(isAuthed) {
  refs.authPanel.hidden = isAuthed;
  refs.appPanel.hidden = !isAuthed;
  refs.logoutBtn.hidden = !isAuthed;
  if (!isAuthed) {
    refs.userLabel.textContent = "未登录";
  }
}

async function handleSession(session) {
  if (!session || !session.user) {
    state.user = null;
    state.profile = null;
    state.isAdmin = false;
    state.data = {
      profiles: [],
      shares: [],
      periods: [],
      capitalEntries: [],
      expenses: []
    };
    setAuthedUI(false);
    return;
  }

  state.user = session.user;
  setAuthedUI(true);

  try {
    await initProfileForUser();
    await refreshAll();
  } catch (error) {
    showMessage(error.message || "加载数据失败", true);
  }
}

function bindEvents() {
  refs.loginForm.addEventListener("submit", onLoginSubmit);
  refs.logoutBtn.addEventListener("click", onLogout);
  refs.periodForm.addEventListener("submit", onPeriodSubmit);
  refs.capitalForm.addEventListener("submit", onCapitalSubmit);
  refs.expenseForm.addEventListener("submit", onExpenseSubmit);
}

async function init() {
  if (!window.supabase || typeof window.supabase.createClient !== "function") {
    refs.authPanel.hidden = true;
    refs.appPanel.hidden = true;
    showMessage("Supabase SDK 加载失败，请刷新页面重试。", true);
    return;
  }

  const config = getSupabaseConfig();
  if (!config) {
    refs.authPanel.hidden = true;
    refs.appPanel.hidden = true;
    showMessage("未配置 Supabase。刷新页面后输入 URL 和 anon key。", true);
    return;
  }

  state.supabase = window.supabase.createClient(config.url, config.anonKey);
  bindEvents();

  const { data, error } = await state.supabase.auth.getSession();
  if (error) {
    showMessage(error.message || "获取会话失败", true);
    return;
  }

  await handleSession(data.session);

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    await handleSession(session);
  });
}

init();
