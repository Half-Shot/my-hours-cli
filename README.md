my-hours-cli
============

A CLI frontend for [MyHours](https://myhours.com).


## Setup

```sh
yarn 
yarn cli # Will automatically ask you to configure the client
```

## Usage

```sh
$ yarn cli help
Usage: my-hours-cli [options] [command]

Options:
  -h, --help          display help for command

Commands:
  start <note>        Track a new task
  running             Get running tasks
  previous [options]  Get tasks from the previous day
  today [options]     Get tasks for today
  stop [taskId]       Stop a task.
  fudge [options]     Distribute hours by project across the week.
  help [command]      display help for command
```
