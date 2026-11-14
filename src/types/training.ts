import { z } from "zod";

/**
 * 训练记录 schema —— W2 结构化输出目标
 *
 * 字段口径严格对齐知识库 `01 每日记录/*-训练-*.md` 的真实结构（不新造口径）：
 *
 *   frontmatter:  type: "training" / session: "腿A" / record_type: "strength"|"cardio"
 *                 duration_min: 79.5 / calorie: 414 / distance_km: 0.78(有氧)
 *   动作明细:     ### 史密斯深蹲（kg）— 容量 2060
 *                 - 组1：40kg × 8，休息 150s
 *                 - 组1：自重 × 40            ← 自重动作 weight 为 null
 *
 * 参照样本：2026-11-07-训练-01-腿A.md（strength, 8 动作）
 *           2026-11-08-训练-01-游泳.md（cardio, 无动作明细）
 */

/** 单组：重量(kg) + 次数。自重动作 weight 为 null（缺值不当 0 用，判档口径同理） */
export const SetSchema = z.object({
  weight: z
    .number({ invalid_type_error: "重量必须是数字" })
    .nonnegative()
    .nullable(), // 自重 → null
  reps: z
    .number({ invalid_type_error: "次数必须是数字" })
    .int("次数必须是整数")
    .positive("次数必须大于 0"),
  rest_s: z.number().int().nonnegative().optional(), // 休息秒数，有就填
});

/** 单个动作：组数 = sets.length（不单独存，避免两处口径） */
export const ExerciseSchema = z.object({
  name: z.string().trim().min(1, "动作名不能为空"),
  sets: z.array(SetSchema).min(1, "至少要有一组"),
  volume: z.number().nonnegative().optional(), // 容量，文中有时直接给出
});

export const TrainingRecordSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD"),
  session: z.string().trim().min(1), // "腿A" / "游泳"
  record_type: z.enum(["strength", "cardio"]).default("strength"),
  duration_min: z.number().positive().optional(),
  calorie: z.number().nonnegative().optional(),
  distance_km: z.number().nonnegative().optional(), // 仅 cardio
  exercises: z.array(ExerciseSchema).default([]), // cardio → []
});

export type TrainingSet = z.infer<typeof SetSchema>;
export type Exercise = z.infer<typeof ExerciseSchema>;
export type TrainingRecord = z.infer<typeof TrainingRecordSchema>;

/** 力量记录约束：strength 必须至少有一个动作（superRefine 不破坏 safeParse 路径） */
export const StrengthRecordSchema = TrainingRecordSchema.superRefine(
  (val, ctx) => {
    if (val.record_type === "strength" && val.exercises.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exercises"],
        message: "力量训练必须至少包含一个动作",
      });
    }
  }
);
