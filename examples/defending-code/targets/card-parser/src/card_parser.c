/*
 * card_parser: a tiny line-oriented parser for "contact card" files.
 *
 * Input format (one field per line, `KEY: VALUE`):
 *
 *     NAME: Ada Lovelace
 *     EMAIL: ada@example.com
 *     TAGS: math,compute,poetry
 *
 * Usage: card_parser <file>
 *
 * On a well-formed card the program prints a one-line summary and exits 0.
 *
 * This program is DELIBERATELY VULNERABLE. It is the target for the
 * defending-code reference harness port and exists only so that an automated
 * agent pipeline can rediscover the bugs by execution (compiled with
 * AddressSanitizer) and then patch them. Do not copy this code into anything
 * real.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_LINE 1024
#define NAME_LEN 32
#define EMAIL_LEN 32
#define MAX_TAGS 4
#define TAG_LEN 24

/* Strip a single trailing newline (and carriage return) in place. */
static void chomp(char *s) {
	size_t n = strlen(s);
	while (n > 0 && (s[n - 1] == '\n' || s[n - 1] == '\r')) {
		s[--n] = '\0';
	}
}

/* Return the value that follows "KEY:" on a line, or NULL if no match.
 * Leading spaces in the value are skipped. */
static char *field_value(char *line, const char *key) {
	size_t klen = strlen(key);
	if (strncmp(line, key, klen) != 0 || line[klen] != ':') {
		return NULL;
	}
	char *v = line + klen + 1;
	while (*v == ' ') {
		v++;
	}
	return v;
}

/* NAME subsystem: copy the display name into the caller's buffer. */
static void parse_name(char *name, const char *value) {
	strcpy(name, value);
}

/* EMAIL subsystem: return a heap copy of the address.
 * Addresses are assumed to fit in a small fixed buffer. */
static char *parse_email(const char *value) {
	char *email = malloc(EMAIL_LEN);
	strcpy(email, value);
	return email;
}

/* TAGS subsystem: split a comma-separated list into the caller's tag table.
 * Returns the number of tags parsed. */
static int parse_tags(char tags[][TAG_LEN], char *value) {
	int count = 0;
	char *tok = strtok(value, ",");
	while (tok != NULL) {
		strcpy(tags[count], tok);
		count++;
		tok = strtok(NULL, ",");
	}
	return count;
}

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "usage: %s <file>\n", argv[0]);
		return 2;
	}

	FILE *f = fopen(argv[1], "r");
	if (f == NULL) {
		fprintf(stderr, "cannot open %s\n", argv[1]);
		return 2;
	}

	char name[NAME_LEN];
	strcpy(name, "(none)");
	char *email = NULL;
	char tags[MAX_TAGS][TAG_LEN];
	int tag_count = 0;

	char line[MAX_LINE];
	char *v;
	while (fgets(line, sizeof(line), f) != NULL) {
		chomp(line);
		if (line[0] == '\0') {
			continue;
		}
		if ((v = field_value(line, "NAME")) != NULL) {
			parse_name(name, v);
		} else if ((v = field_value(line, "EMAIL")) != NULL) {
			free(email);
			email = parse_email(v);
		} else if ((v = field_value(line, "TAGS")) != NULL) {
			tag_count = parse_tags(tags, v);
		}
		/* Unknown keys are ignored. */
	}
	fclose(f);

	printf("Parsed: name=\"%s\" email=%s tags=%d\n", name,
	       email ? email : "(none)", tag_count);

	free(email);
	return 0;
}
