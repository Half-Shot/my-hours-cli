export interface MyHoursTask {
    id: number;
    note: string|null;
    date: string;
    running: boolean;
    duration: number;
    tags: Array<MyHoursTag>;
    times: Array<Times>;
}

interface Times {
    duration: number;
    startTime: string;
    endTime: string;
    running: boolean;
    id: number;
}

export interface MyHoursTag {
    name: string;
    hexColor: string;
    archived: boolean;
    dateArchived: string|null;
    id: number;
}