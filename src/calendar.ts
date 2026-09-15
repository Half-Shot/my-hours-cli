import { async as icalAsync, expandRecurringEvent, CalendarResponse, VEvent } from "node-ical";
import * as luxon from "luxon";

function textValue(value: string | { val: string } | undefined): string {
    if (!value) {
        return "";
    }
    return typeof value === "string" ? value : value.val;
}

function isHolidayEvent(event: VEvent): boolean {
    return textValue(event.summary).toLowerCase().includes("holiday");
}

export function extractHolidayDates(calendar: CalendarResponse, weekStart: luxon.DateTime, weekEnd: luxon.DateTime): Set<string> {
    const holidayDates = new Set<string>();

    for (const component of Object.values(calendar)) {
        if (!component || component.type !== "VEVENT" || !isHolidayEvent(component)) {
            continue;
        }
        const instances = expandRecurringEvent(component, { from: weekStart.toJSDate(), to: weekEnd.toJSDate() });
        for (const instance of instances) {
            // DTEND is exclusive for all-day events (RFC 5545), so the last covered day is one before it.
            const end = luxon.DateTime.fromJSDate(instance.end);
            const lastDay = (instance.isFullDay ? end.minus({ days: 1 }) : end).startOf("day");
            let cursor = luxon.DateTime.fromJSDate(instance.start).startOf("day");
            while (cursor <= lastDay) {
                if (cursor >= weekStart && cursor <= weekEnd && cursor.weekday < 6) {
                    holidayDates.add(cursor.toISODate() as string);
                }
                cursor = cursor.plus({ days: 1 });
            }
        }
    }

    return holidayDates;
}

export async function getHolidayDates(icalUrl: string, weekStart: luxon.DateTime, weekEnd: luxon.DateTime): Promise<Set<string>> {
    const calendar = await icalAsync.fromURL(icalUrl);
    return extractHolidayDates(calendar, weekStart, weekEnd);
}
