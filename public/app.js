const RECEIPT_BUCKET = "receipts";
const TEAM_RESERVE_FLOOR = 5000;
const DEFAULT_SUPABASE_URL = "https://ilhqabnqigtmjftpywxk.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_OOJBj2Ag_h4LvKa2e03K3Q_SrcFr1jV";

const state = {
  supabase: null,
  user: null,
  profile: null,
  isAdmin: false,
  selectedPeriodId: null,
  data: {
    profiles: [],
    members: [],
    memberHashrates: [],
    accountBindings: [],
    periods: [],
    capitalEntries: [],
    expenses: []
  }
};

const refs = {
  authPanel: document.getElementById("auth-panel"),
  appPanel: document.getElementById("app-panel"),
  adminPanel: document.getElementById("admin-panel"),
  message: document.getElementById("message"),
  loginForm: document.getElementById("login-form"),
  registerForm: document.getElementById("register-form"),
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
  settlementRows: document.getElementById("settlement-rows"),
  memberCreateForm: document.getElementById("member-create-form"),
  adminMemberRows: document.getElementById("admin-member-rows"),
  accountBindingRows: document.getElementById("account-binding-rows"),
  capitalMemberSelect: document.getElementById("capital-member-select"),
  expenseMemberSelect: document.getElementById("expense-member-select")
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
  }, 3800);
}

function getSupabaseConfig() {
  const url = DEFAULT_SUPABASE_URL;
  const anonKey = DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !anonKey) {
    return null;
  }

  return {
    url: url.trim(),
    anonKey: anonKey.trim()
  };
}

function getCurrentPeriod() {
  return state.data.periods.find((item) => item.id === state.selectedPeriodId) || null;
}

function memberById(memberId) {
  return state.data.members.find((item) => item.id === memberId) || null;
}

function memberName(memberId) {
  const member = memberById(memberId);
  return member ? member.member_name : "未绑定成员";
}

function profileLabel(profile) {
  if (!profile) {
    return "-";
  }
  if (profile.email) {
    return profile.email;
  }
  return profile.display_name || profile.id;
}

function getHashrateMap() {
  const map = new Map();
  state.data.memberHashrates.forEach((row) => {
    map.set(row.member_id, toNumber(row.hashrate_ths));
  });
  return map;
}

function getActiveMembers() {
  return state.data.members.filter((item) => item.is_active).sort((a, b) => a.member_name.localeCompare(b.member_name, "zh-Hans-CN"));
}

function getBindingMap() {
  const map = new Map();
  state.data.accountBindings
    .filter((row) => row.is_active)
    .forEach((row) => {
      if (!map.has(row.profile_id)) {
        map.set(row.profile_id, row.member_id);
      }
    });
  return map;
}

function getAccessibleMembersForCurrentUser() {
  const activeMembers = getActiveMembers();
  if (state.isAdmin) {
    return activeMembers;
  }

  const memberId = getBindingMap().get(state.user.id);
  if (!memberId) {
    return [];
  }
  return activeMembers.filter((item) => item.id === memberId);
}

function canUseMember(memberId) {
  if (state.isAdmin) {
    return true;
  }
  const own = getBindingMap().get(state.user.id);
  return own === memberId;
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

function getShareMap() {
  const members = getActiveMembers();
  const hashrateMap = getHashrateMap();
  const totalHashrate = members.reduce((sum, m) => sum + (hashrateMap.get(m.id) || 0), 0);
  const map = new Map();

  members.forEach((member) => {
    const hashrate = hashrateMap.get(member.id) || 0;
    map.set(member.id, totalHashrate > 0 ? hashrate / totalHashrate : 0);
  });

  return { members, hashrateMap, totalHashrate, shareMap: map };
}

function computeSettlement(period) {
  const { members, shareMap, totalHashrate } = getShareMap();

  if (!period) {
    return {
      rows: [],
      totals: {
        commonExpense: 0,
        totalHashrate,
        totalCapital: 0
      }
    };
  }

  const scopedExpenses = state.data.expenses.filter((row) => inPeriod(row.expense_date, period));
  const scopedCapital = state.data.capitalEntries.filter((row) => inPeriod(row.entry_date, period));
  const commonExpense = scopedExpenses.reduce((sum, row) => sum + toNumber(row.amount), 0);

  const rows = members.map((member) => {
    const memberId = member.id;
    const shareRatio = shareMap.get(memberId) || 0;

    const personalPaid = scopedExpenses
      .filter((row) => row.member_id === memberId && row.payment_source === "personal")
      .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const capitalInPeriod = scopedCapital
      .filter((row) => row.member_id === memberId)
      .reduce((sum, row) => sum + toNumber(row.amount), 0);

    const allocatedCost = commonExpense * shareRatio;
    const contributed = capitalInPeriod + personalPaid;
    const net = contributed - allocatedCost;

    return {
      member_id: memberId,
      member_name: member.member_name,
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

  const { data: existing, error: existingError } = await sb
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();
  if (existingError) {
    throw existingError;
  }

  if (!existing) {
    const baseProfile = {
      id: user.id,
      display_name: (user.email || "").split("@")[0] || "member",
      role: "member",
      email: user.email || null
    };
    const { error: insertError } = await sb.from("profiles").insert(baseProfile);
    if (insertError) {
      throw insertError;
    }
  } else if (user.email) {
    const { error: patchEmailError } = await sb
      .from("profiles")
      .update({ email: user.email })
      .eq("id", user.id)
      .is("email", null);
    if (patchEmailError) {
      throw patchEmailError;
    }
  }

  const { data: ensuredProfile, error: ensuredError } = await sb
    .from("profiles")
    .select("id, display_name, role, email")
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

  const [profilesRes, membersRes, hashratesRes, bindingsRes, periodsRes, capitalRes, expenseRes] = await Promise.all([
    sb.from("profiles").select("id, display_name, role, email").order("created_at", { ascending: true }),
    sb.from("members").select("id, member_name, note, is_active").order("member_name", { ascending: true }),
    sb.from("member_hashrates").select("member_id, hashrate_ths"),
    sb.from("account_member_bindings").select("id, profile_id, member_id, is_active"),
    sb.from("settlement_periods").select("id, title, start_date, end_date, status").order("start_date", { ascending: false }),
    sb
      .from("capital_entries")
      .select("id, owner_id, member_id, amount, entry_date, description, receipt_path, created_at")
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300),
    sb
      .from("expenses")
      .select("id, payer_id, member_id, amount, expense_date, category, payment_source, description, receipt_path, created_at")
      .order("expense_date", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(300)
  ]);

  for (const res of [profilesRes, membersRes, hashratesRes, bindingsRes, periodsRes, capitalRes, expenseRes]) {
    if (res.error) {
      throw res.error;
    }
  }

  state.data.profiles = profilesRes.data || [];
  state.data.members = membersRes.data || [];
  state.data.memberHashrates = hashratesRes.data || [];
  state.data.accountBindings = bindingsRes.data || [];
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

function renderSummary() {
  const period = getCurrentPeriod();
  const settlement = computeSettlement(period);
  const poolBalance = computePoolBalance();
  const accountMember = memberName(getBindingMap().get(state.user.id));

  const cards = [
    {
      label: "当前项目备用金池",
      value: formatMoney(poolBalance),
      helper: poolBalance < TEAM_RESERVE_FLOOR ? `低于安全线 ${TEAM_RESERVE_FLOOR}` : `安全线 ${TEAM_RESERVE_FLOOR}`
    },
    {
      label: "我的归属成员",
      value: state.isAdmin ? "管理员" : safe(accountMember),
      helper: state.isAdmin ? "可管理全部成员与账号绑定" : "由管理员绑定"
    },
    {
      label: "本期公共总支出",
      value: formatMoney(settlement.totals.commonExpense),
      helper: "按成员机器总算力占比分摊"
    },
    {
      label: "当前结算周期",
      value: period ? safe(period.title) : "未选择",
      helper: period ? `${period.start_date} ~ ${period.end_date}` : "先创建一个周期"
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
  refs.periodRows.innerHTML = state.data.periods
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
  const { members, hashrateMap, totalHashrate } = getShareMap();

  refs.memberRows.innerHTML = members
    .map((member) => {
      const hashrate = hashrateMap.get(member.id) || 0;
      const ratio = totalHashrate > 0 ? hashrate / totalHashrate : 0;
      const action = state.isAdmin
        ? `
          <div class="action-row">
            <input class="share-input" data-id="${member.id}" type="number" step="0.01" value="${hashrate}" style="max-width:120px;" />
            <button class="btn mini ghost member-save" data-id="${member.id}">保存</button>
          </div>
        `
        : "-";

      return `
        <tr>
          <td>${safe(member.member_name)}</td>
          <td>${formatMoney(hashrate)}</td>
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
        const { error } = await state.supabase.from("member_hashrates").upsert(
          {
            member_id: button.dataset.id,
            hashrate_ths: hashrate,
            updated_at: new Date().toISOString()
          },
          { onConflict: "member_id" }
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

function renderAdminPanel() {
  refs.adminPanel.hidden = !state.isAdmin;
  if (!state.isAdmin) {
    return;
  }

  const activeLabel = (flag) => (flag ? "启用" : "停用");

  refs.adminMemberRows.innerHTML = state.data.members
    .map(
      (member) => `
      <tr>
        <td>${safe(member.member_name)}</td>
        <td>${safe(activeLabel(member.is_active))}</td>
        <td>${safe(member.note || "-")}</td>
      </tr>
    `
    )
    .join("");

  const memberOptions = ['<option value="">未绑定</option>']
    .concat(state.data.members.map((m) => `<option value="${m.id}">${safe(m.member_name)}</option>`))
    .join("");

  const currentBindingMap = getBindingMap();

  refs.accountBindingRows.innerHTML = state.data.profiles
    .map((profile) => {
      const boundMemberId = currentBindingMap.get(profile.id) || "";
      return `
      <tr>
        <td>${safe(profileLabel(profile))}</td>
        <td>
          <select class="binding-select" data-profile-id="${profile.id}">
            ${memberOptions}
          </select>
        </td>
        <td><button class="btn mini ghost binding-save" data-profile-id="${profile.id}">保存</button></td>
      </tr>
    `;
    })
    .join("");

  refs.accountBindingRows.querySelectorAll(".binding-select").forEach((select) => {
    const profileId = select.dataset.profileId;
    select.value = currentBindingMap.get(profileId) || "";
  });

  refs.accountBindingRows.querySelectorAll(".binding-save").forEach((button) => {
    button.addEventListener("click", async () => {
      const profileId = button.dataset.profileId;
      const select = refs.accountBindingRows.querySelector(`.binding-select[data-profile-id="${profileId}"]`);
      const memberId = select ? select.value : "";

      try {
        if (!memberId) {
          const { error } = await state.supabase.from("account_member_bindings").delete().eq("profile_id", profileId);
          if (error) {
            throw error;
          }
          await refreshAll("账号绑定已清除。");
          return;
        }

        const { error } = await state.supabase.from("account_member_bindings").upsert(
          {
            profile_id: profileId,
            member_id: memberId,
            is_active: true,
            updated_at: new Date().toISOString()
          },
          { onConflict: "profile_id" }
        );

        if (error) {
          throw error;
        }

        await refreshAll("账号绑定已更新。");
      } catch (error) {
        showMessage(error.message || "绑定失败", true);
      }
    });
  });
}

function renderMemberSelects() {
  const members = getAccessibleMembersForCurrentUser();

  const options = members.map((member) => `<option value="${member.id}">${safe(member.member_name)}</option>`).join("");

  refs.capitalMemberSelect.innerHTML = options || '<option value="">无可用成员</option>';
  refs.expenseMemberSelect.innerHTML = options || '<option value="">无可用成员</option>';

  refs.capitalMemberSelect.disabled = members.length === 0;
  refs.expenseMemberSelect.disabled = members.length === 0;
}

function canEditCapitalRow(ownerId) {
  return ownerId === state.user.id;
}

function canEditExpenseRow(payerId) {
  return payerId === state.user.id;
}

function renderCapitalRows() {
  refs.capitalRows.innerHTML = state.data.capitalEntries
    .map((row) => {
      const amount = toNumber(row.amount);
      const cls = amount >= 0 ? "money-plus" : "money-minus";
      const receipt = row.receipt_path
        ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">查看</a>`
        : "-";
      const actions = canEditCapitalRow(row.owner_id)
        ? `<button class="btn mini danger capital-del" data-id="${row.id}">删除</button>`
        : "-";

      return `
        <tr>
          <td>${safe(dateOnly(row.entry_date))}</td>
          <td>${safe(memberName(row.member_id))}</td>
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
      const receipt = row.receipt_path
        ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">查看</a>`
        : "-";
      const actions = canEditExpenseRow(row.payer_id)
        ? `<button class="btn mini danger expense-del" data-id="${row.id}">删除</button>`
        : "-";

      return `
        <tr>
          <td>${safe(dateOnly(row.expense_date))}</td>
          <td>${safe(memberName(row.member_id))}</td>
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
  const settlement = computeSettlement(period);
  const { shareMap } = getShareMap();
  const poolBalance = computePoolBalance();

  refs.settlementRows.innerHTML = settlement.rows
    .map((row) => {
      const targetReserve = TEAM_RESERVE_FLOOR * (shareMap.get(row.member_id) || 0);
      const shouldTopUp = Math.max(0, targetReserve - Math.max(0, row.net));
      const netClass = row.net >= 0 ? "money-plus" : "money-minus";

      return `
        <tr>
          <td>${safe(row.member_name)}</td>
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
    refs.settlementRows.innerHTML = `<tr><td colspan="7">请先添加成员，并创建结算周期。</td></tr>`;
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
  const roleText = state.isAdmin ? "admin" : "member";
  const userText = state.profile.email || state.profile.display_name || "当前用户";
  refs.userLabel.textContent = `${userText} (${roleText})`;
  renderSummary();
  renderAdminPanel();
  renderPeriods();
  renderMembers();
  renderMemberSelects();
  renderCapitalRows();
  renderExpenseRows();
  renderSettlement();
  bindReceiptLinks();
}

async function refreshCurrentRole() {
  if (!state.user) {
    state.isAdmin = false;
    return;
  }
  const { data, error } = await state.supabase
    .from("profiles")
    .select("role, email, display_name")
    .eq("id", state.user.id)
    .single();
  if (error) {
    throw error;
  }
  state.profile = {
    ...state.profile,
    ...data
  };
  state.isAdmin = data.role === "admin";
}

async function refreshAll(successMessage) {
  await loadData();
  await refreshCurrentRole();
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

async function onRegisterSubmit(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(refs.registerForm).entries());
  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");
  const confirmPassword = String(payload.confirm_password || "");

  if (!email) {
    showMessage("请输入邮箱", true);
    return;
  }
  if (password.length < 6) {
    showMessage("密码至少 6 位", true);
    return;
  }
  if (password !== confirmPassword) {
    showMessage("两次输入的密码不一致", true);
    return;
  }

  try {
    const { error } = await state.supabase.auth.signUp({
      email,
      password
    });
    if (error) {
      throw error;
    }
    refs.registerForm.reset();
    showMessage("注册成功。请先登录，随后由管理员绑定到对应成员。");
  } catch (error) {
    showMessage(error.message || "注册失败", true);
  }
}

async function onPeriodSubmit(event) {
  event.preventDefault();
  await refreshCurrentRole();
  if (!state.isAdmin) {
    showMessage(`只有管理员可以新增结算周期（当前角色：${state.profile.role || "unknown"}）`, true);
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

async function onMemberCreateSubmit(event) {
  event.preventDefault();
  await refreshCurrentRole();
  if (!state.isAdmin) {
    showMessage("只有管理员可以新增成员", true);
    return;
  }

  const payload = Object.fromEntries(new FormData(refs.memberCreateForm).entries());
  const memberName = String(payload.member_name || "").trim();
  if (!memberName) {
    showMessage("成员名称不能为空", true);
    return;
  }

  try {
    const { error } = await state.supabase.from("members").insert({
      member_name: memberName,
      note: String(payload.note || "").trim(),
      is_active: true,
      created_by: state.user.id
    });

    if (error) {
      throw error;
    }

    refs.memberCreateForm.reset();
    await refreshAll("成员已新增。");
  } catch (error) {
    showMessage(error.message || "新增成员失败", true);
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
    if (!payload.member_id) {
      showMessage("请先选择归属成员", true);
      return;
    }
    if (!canUseMember(payload.member_id)) {
      showMessage("当前账号无权录入该成员数据", true);
      return;
    }

    const receiptFile = form.querySelector('input[name="receipt"]').files[0];
    const receiptPath = await uploadReceipt(receiptFile);

    const { error } = await state.supabase.from("capital_entries").insert({
      owner_id: state.user.id,
      member_id: payload.member_id,
      amount,
      entry_date: payload.entry_date,
      description: String(payload.description || "").trim(),
      receipt_path: receiptPath
    });

    if (error) {
      throw error;
    }

    form.reset();
    renderMemberSelects();
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
    if (!payload.member_id) {
      showMessage("请先选择归属成员", true);
      return;
    }
    if (!canUseMember(payload.member_id)) {
      showMessage("当前账号无权录入该成员数据", true);
      return;
    }

    const receiptFile = form.querySelector('input[name="receipt"]').files[0];
    const receiptPath = await uploadReceipt(receiptFile);

    const { error } = await state.supabase.from("expenses").insert({
      payer_id: state.user.id,
      member_id: payload.member_id,
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
    renderMemberSelects();
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
  if (refs.registerForm) {
    refs.registerForm.addEventListener("submit", onRegisterSubmit);
  }
  refs.logoutBtn.addEventListener("click", onLogout);
  refs.periodForm.addEventListener("submit", onPeriodSubmit);
  refs.capitalForm.addEventListener("submit", onCapitalSubmit);
  refs.expenseForm.addEventListener("submit", onExpenseSubmit);
  if (refs.memberCreateForm) {
    refs.memberCreateForm.addEventListener("submit", onMemberCreateSubmit);
  }
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
    showMessage("未配置 Supabase，请联系管理员更新默认配置。", true);
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
