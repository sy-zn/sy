(function () {
  const T = {
    edit: "\u4fee\u6539",
    del: "\u5220\u9664",
    cancel: "\u5df2\u53d6\u6d88",
    saved: "\u5df2\u4fdd\u5b58\u4fee\u6539\u3002",
    deleted: "\u5df2\u5220\u9664\u3002",
    fail: "\u64cd\u4f5c\u5931\u8d25",
    confirmPeriodDelete: "\u786e\u8ba4\u5220\u9664\u8fd9\u4e2a\u7ed3\u7b97\u5468\u671f\uff1f\u4e0d\u4f1a\u5220\u9664\u5df2\u6709\u8bb0\u5f55\uff0c\u4f46\u8be5\u5468\u671f\u4e0d\u518d\u663e\u793a\u3002",
    confirmCapitalDelete: "\u786e\u8ba4\u5220\u9664\u8fd9\u6761\u5165\u91d1/\u63d0\u56de\u8bb0\u5f55\uff1f",
    confirmExpenseDelete: "\u786e\u8ba4\u5220\u9664\u8fd9\u6761\u652f\u51fa\u8bb0\u5f55\uff1f"
  };

  function canTouch(ownerId) {
    return state.isAdmin || ownerId === state.user.id;
  }

  function ask(label, currentValue) {
    const value = window.prompt(label, currentValue == null ? "" : String(currentValue));
    return value === null ? null : value.trim();
  }

  async function save(table, id, patch, okText) {
    const { error } = await state.supabase.from(table).update(patch).eq("id", id);
    if (error) throw error;
    await refreshAll(okText || T.saved);
  }

  async function remove(table, id, question) {
    if (!window.confirm(question)) return;
    const { error } = await state.supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    await refreshAll(T.deleted);
  }

  window.canEditCapitalRow = function (ownerId) {
    return canTouch(ownerId);
  };

  window.canEditExpenseRow = function (payerId) {
    return canTouch(payerId);
  };

  window.renderPeriods = function () {
    refs.periodRows.innerHTML = state.data.periods
      .map((period) => {
        const selected = period.id === state.selectedPeriodId;
        const adminActions = state.isAdmin
          ? `<button class="btn mini ghost period-edit" data-id="${period.id}">${T.edit}</button>
             <button class="btn mini danger period-del" data-id="${period.id}">${T.del}</button>
             ${period.status === "open" ? `<button class="btn mini warn period-lock" data-id="${period.id}">\u9501\u8d26</button>` : ""}`
          : "";
        return `
          <tr>
            <td>${safe(period.title)}${selected ? " (\u5f53\u524d)" : ""}</td>
            <td>${safe(period.start_date)} ~ ${safe(period.end_date)}</td>
            <td><span class="badge ${safe(period.status)}">${safe(period.status)}</span></td>
            <td><div class="action-row"><button class="btn mini ghost period-select" data-id="${period.id}">\u67e5\u770b</button>${adminActions}</div></td>
          </tr>`;
      })
      .join("");

    refs.periodRows.querySelectorAll(".period-select").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.selectedPeriodId = btn.dataset.id;
        renderAll();
      });
    });

    refs.periodRows.querySelectorAll(".period-edit").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = state.data.periods.find((item) => item.id === btn.dataset.id);
        if (!row) return;
        const title = ask("\u5468\u671f\u6807\u9898", row.title);
        if (title === null) return;
        const start = ask("\u5f00\u59cb\u65e5\u671f YYYY-MM-DD", row.start_date);
        if (start === null) return;
        const end = ask("\u7ed3\u675f\u65e5\u671f YYYY-MM-DD", row.end_date);
        if (end === null) return;
        try {
          await save("settlement_periods", row.id, {
            title,
            start_date: start,
            end_date: end,
            start_at: `${start}T00:00:00+08:00`,
            end_at: `${end}T23:59:59+08:00`
          });
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });

    refs.periodRows.querySelectorAll(".period-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await remove("settlement_periods", btn.dataset.id, T.confirmPeriodDelete);
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });

    refs.periodRows.querySelectorAll(".period-lock").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (!window.confirm("\u9501\u8d26\u540e\u8be5\u5468\u671f\u6570\u636e\u4e0d\u53ef\u4fee\u6539\uff0c\u786e\u8ba4\u9501\u8d26\uff1f")) return;
        try {
          await save("settlement_periods", btn.dataset.id, { status: "locked", locked_at: new Date().toISOString() }, "\u5468\u671f\u5df2\u9501\u5b9a\u3002");
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });
  };

  window.renderCapitalRows = function () {
    refs.capitalRows.innerHTML = state.data.capitalEntries
      .map((row) => {
        const amount = toNumber(row.amount);
        const cls = amount >= 0 ? "money-plus" : "money-minus";
        const receipt = row.receipt_path ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">\u67e5\u770b</a>` : "-";
        const actions = canTouch(row.owner_id)
          ? `<button class="btn mini ghost capital-edit" data-id="${row.id}">${T.edit}</button>
             <button class="btn mini danger capital-del" data-id="${row.id}">${T.del}</button>`
          : "-";
        return `<tr>
          <td>${safe(dateOnly(row.entry_date))}</td>
          <td>${safe(memberName(row.member_id))}</td>
          <td class="${cls}">${formatMoney(amount)}</td>
          <td>${safe(row.description || "-")}</td>
          <td>${receipt}</td>
          <td><div class="action-row">${actions}</div></td>
        </tr>`;
      })
      .join("");

    refs.capitalRows.querySelectorAll(".capital-edit").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = state.data.capitalEntries.find((item) => item.id === btn.dataset.id);
        if (!row) return;
        const entryDate = ask("\u65e5\u671f YYYY-MM-DD", dateOnly(row.entry_date));
        if (entryDate === null) return;
        const amount = ask("\u91d1\u989d\uff08\u6b63\u6570\u5165\u91d1\uff0c\u8d1f\u6570\u63d0\u56de\uff09", row.amount);
        if (amount === null) return;
        const description = ask("\u8bf4\u660e", row.description || "");
        if (description === null) return;
        try {
          await save("capital_entries", row.id, {
            entry_date: entryDate,
            amount: Number(amount),
            description
          });
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });

    refs.capitalRows.querySelectorAll(".capital-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await remove("capital_entries", btn.dataset.id, T.confirmCapitalDelete);
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });
  };

  window.renderExpenseRows = function () {
    refs.expenseRows.innerHTML = state.data.expenses
      .map((row) => {
        const receipt = row.receipt_path ? `<a href="#" class="link-btn receipt-open" data-path="${safe(row.receipt_path)}">\u67e5\u770b</a>` : "-";
        const actions = canTouch(row.payer_id)
          ? `<button class="btn mini ghost expense-edit" data-id="${row.id}">${T.edit}</button>
             <button class="btn mini danger expense-del" data-id="${row.id}">${T.del}</button>`
          : "-";
        return `<tr>
          <td>${safe(dateOnly(row.expense_date))}</td>
          <td>${safe(memberName(row.member_id))}</td>
          <td>${formatMoney(row.amount)}</td>
          <td>${safe(row.payment_source)}</td>
          <td>${safe(row.category)}</td>
          <td>${safe(row.description || "-")}</td>
          <td>${receipt}</td>
          <td><div class="action-row">${actions}</div></td>
        </tr>`;
      })
      .join("");

    refs.expenseRows.querySelectorAll(".expense-edit").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const row = state.data.expenses.find((item) => item.id === btn.dataset.id);
        if (!row) return;
        const expenseDate = ask("\u65e5\u671f YYYY-MM-DD", dateOnly(row.expense_date));
        if (expenseDate === null) return;
        const amount = ask("\u91d1\u989d", row.amount);
        if (amount === null) return;
        const category = ask("\u7c7b\u522b electricity/salary/maintenance/hospitality/travel/other", row.category);
        if (category === null) return;
        const paymentSource = ask("\u4ed8\u6b3e\u6765\u6e90 pool/personal", row.payment_source);
        if (paymentSource === null) return;
        const description = ask("\u8bf4\u660e", row.description || "");
        if (description === null) return;
        try {
          await save("expenses", row.id, {
            expense_date: expenseDate,
            amount: Number(amount),
            category,
            payment_source: paymentSource,
            description
          });
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });

    refs.expenseRows.querySelectorAll(".expense-del").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await remove("expenses", btn.dataset.id, T.confirmExpenseDelete);
        } catch (error) {
          showMessage(error.message || T.fail, true);
        }
      });
    });
  };
})();
